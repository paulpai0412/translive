param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("detect", "resolve", "snapshot", "apply", "restore", "snapshot-all-roles", "apply-all-roles", "restore-all-roles")]
  [string]$Action,
  [ValidateSet("teams", "zoom")]
  [string]$App,
  [string]$CaptureName,
  [string]$RenderName,
  [string]$CaptureId,
  [string]$RenderId,
  [string]$CaptureConsoleId,
  [string]$CaptureMultimediaId,
  [string]$CaptureCommunicationsId,
  [string]$RenderConsoleId,
  [string]$RenderMultimediaId,
  [string]$RenderCommunicationsId
)

$ErrorActionPreference = "Stop"

$interop = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace TransLive.Audio {
  public enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  public enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceCollection {
    int GetCount(out uint pcDevices);
    int Item(uint nDevice, out IMMDevice ppDevice);
  }

  [StructLayout(LayoutKind.Sequential)]
  internal struct PROPERTYKEY {
    public Guid fmtid;
    public uint pid;
  }

  [StructLayout(LayoutKind.Explicit)]
  internal struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr pointerValue;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPropertyStore {
    int GetCount(out uint cProps);
    int GetAt(uint iProp, out PROPERTYKEY pkey);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
    int Commit();
  }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(EDataFlow dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
    int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);
    int GetDevice(string pwstrId, out IMMDevice ppDevice);
    int RegisterEndpointNotificationCallback(IntPtr pClient);
    int UnregisterEndpointNotificationCallback(IntPtr pClient);
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumeratorComObject { }

  // Windows exposes no supported public API for changing default endpoints.
  // Callers snapshot, verify, and restore every requested role instead of
  // relying on an unverified change.
  [ComImport, Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPolicyConfig {
    int GetMixFormat(string deviceId, IntPtr format);
    int GetDeviceFormat(string deviceId, int defaultFormat, IntPtr format);
    int ResetDeviceFormat(string deviceId);
    int SetDeviceFormat(string deviceId, IntPtr endpointFormat, IntPtr mixFormat);
    int GetProcessingPeriod(string deviceId, int defaultPeriod, IntPtr defaultPeriodValue, IntPtr minimumPeriodValue);
    int SetProcessingPeriod(string deviceId, IntPtr period);
    int GetShareMode(string deviceId, IntPtr mode);
    int SetShareMode(string deviceId, IntPtr mode);
    int GetPropertyValue(string deviceId, IntPtr key, IntPtr value);
    int SetPropertyValue(string deviceId, IntPtr key, IntPtr value);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, ERole role);
    int SetEndpointVisibility(string deviceId, int visible);
  }

  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")]
  internal class PolicyConfigClient { }

  public static class DevicePolicy {
    [DllImport("Ole32.dll")]
    private static extern int PropVariantClear(ref PROPVARIANT pvar);

    private static void Check(int hresult) {
      if (hresult < 0) Marshal.ThrowExceptionForHR(hresult);
    }

    private static string GetFriendlyName(IMMDevice device) {
      IPropertyStore store;
      Check(device.OpenPropertyStore(0, out store));
      PROPVARIANT value = new PROPVARIANT();
      bool populated = false;
      try {
        var key = new PROPERTYKEY {
          fmtid = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),
          pid = 14
        };
        Check(store.GetValue(ref key, out value));
        populated = true;
        if (value.vt != 31) return null;
        return Marshal.PtrToStringUni(value.pointerValue);
      } finally {
        if (populated) PropVariantClear(ref value);
      }
    }

    public static string ResolveActiveEndpointId(bool capture, string friendlyName) {
      if (String.IsNullOrWhiteSpace(friendlyName)) throw new ArgumentException("Friendly name is required");
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDeviceCollection collection;
      Check(enumerator.EnumAudioEndpoints(
        capture ? EDataFlow.eCapture : EDataFlow.eRender,
        1,
        out collection
      ));
      try {
        uint count;
        Check(collection.GetCount(out count));
        var matches = new List<string>();
        for (uint index = 0; index < count; index++) {
          IMMDevice device;
          Check(collection.Item(index, out device));
          try {
            var name = GetFriendlyName(device);
            if (String.Equals(name, friendlyName, StringComparison.OrdinalIgnoreCase)) {
              string id;
              Check(device.GetId(out id));
              matches.Add(id);
            }
          } finally {
            // Process exits after the command; explicit COM release is not
            // reliable for this interface projection under PowerShell.
          }
        }
        if (matches.Count == 0) throw new ArgumentException("Native endpoint was not found");
        if (matches.Count > 1) throw new ArgumentException("Native endpoint name is ambiguous");
        return matches[0];
      } finally {
        // Process exits after the command; no explicit RCW release required.
      }
    }

    public static string GetDefaultEndpointId(bool capture, ERole role) {
      var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
      IMMDevice device;
      Check(enumerator.GetDefaultAudioEndpoint(
        capture ? EDataFlow.eCapture : EDataFlow.eRender,
        role,
        out device
      ));
      string id;
      Check(device.GetId(out id));
      return id;
    }

    public static string GetDefaultCommunicationsId(bool capture) {
      return GetDefaultEndpointId(capture, ERole.eCommunications);
    }

    public static void SetDefaultEndpointId(string deviceId, ERole role) {
      if (String.IsNullOrWhiteSpace(deviceId)) throw new ArgumentException("Device ID is required");
      var policy = (IPolicyConfig)new PolicyConfigClient();
      Check(policy.SetDefaultEndpoint(deviceId, role));
    }

    public static void SetDefaultCommunicationsId(string deviceId) {
      SetDefaultEndpointId(deviceId, ERole.eCommunications);
    }
  }
}
'@

function Emit-Result($value) {
  $value | ConvertTo-Json -Compress
}

function All-Roles-Snapshot {
  return @{
    capture = @{
      consoleId = [TransLive.Audio.DevicePolicy]::GetDefaultEndpointId($true, [TransLive.Audio.ERole]::eConsole)
      multimediaId = [TransLive.Audio.DevicePolicy]::GetDefaultEndpointId($true, [TransLive.Audio.ERole]::eMultimedia)
      communicationsId = [TransLive.Audio.DevicePolicy]::GetDefaultEndpointId($true, [TransLive.Audio.ERole]::eCommunications)
    }
    render = @{
      consoleId = [TransLive.Audio.DevicePolicy]::GetDefaultEndpointId($false, [TransLive.Audio.ERole]::eConsole)
      multimediaId = [TransLive.Audio.DevicePolicy]::GetDefaultEndpointId($false, [TransLive.Audio.ERole]::eMultimedia)
      communicationsId = [TransLive.Audio.DevicePolicy]::GetDefaultEndpointId($false, [TransLive.Audio.ERole]::eCommunications)
    }
  }
}

function Set-All-Roles([string]$CaptureEndpointId, [string]$RenderEndpointId) {
  foreach ($role in @(
    [TransLive.Audio.ERole]::eConsole,
    [TransLive.Audio.ERole]::eMultimedia,
    [TransLive.Audio.ERole]::eCommunications
  )) {
    [TransLive.Audio.DevicePolicy]::SetDefaultEndpointId($CaptureEndpointId, $role)
    [TransLive.Audio.DevicePolicy]::SetDefaultEndpointId($RenderEndpointId, $role)
  }
}

function Detect-App([string]$Target) {
  $processNames = if ($Target -eq "teams") { @("ms-teams", "teams") } else { @("Zoom") }
  $running = @(
    foreach ($name in $processNames) {
      Get-Process -Name $name -ErrorAction SilentlyContinue
    }
  ).Count -gt 0
  $installed = $running
  if (-not $installed -and $Target -eq "teams") {
    $installed = $null -ne (Get-AppxPackage -Name "MSTeams" -ErrorAction SilentlyContinue)
  }
  if (-not $installed -and $Target -eq "zoom") {
    $installed = Test-Path (Join-Path $env:APPDATA "Zoom\bin\Zoom.exe")
  }
  return @{ ok = $true; installed = $installed; running = $running }
}

try {
  if ($Action -eq "detect") {
    Emit-Result (Detect-App $App)
    exit 0
  }

  if ($env:OS -ne "Windows_NT") {
    throw "Windows audio endpoints are unavailable"
  }

  Add-Type -TypeDefinition $interop

  if ($Action -eq "resolve") {
    Emit-Result @{
      ok = $true
      captureId = [TransLive.Audio.DevicePolicy]::ResolveActiveEndpointId($true, $CaptureName)
      renderId = [TransLive.Audio.DevicePolicy]::ResolveActiveEndpointId($false, $RenderName)
    }
    exit 0
  }

  if ($Action -eq "snapshot") {
    Emit-Result @{
      ok = $true
      captureId = [TransLive.Audio.DevicePolicy]::GetDefaultCommunicationsId($true)
      renderId = [TransLive.Audio.DevicePolicy]::GetDefaultCommunicationsId($false)
    }
    exit 0
  }

  if ($Action -eq "snapshot-all-roles") {
    $snapshot = All-Roles-Snapshot
    $snapshot.ok = $true
    Emit-Result $snapshot
    exit 0
  }

  if ($Action -eq "apply-all-roles") {
    Set-All-Roles $CaptureId $RenderId
    Emit-Result @{ ok = $true }
    exit 0
  }

  if ($Action -eq "restore-all-roles") {
    [TransLive.Audio.DevicePolicy]::SetDefaultEndpointId($CaptureConsoleId, [TransLive.Audio.ERole]::eConsole)
    [TransLive.Audio.DevicePolicy]::SetDefaultEndpointId($CaptureMultimediaId, [TransLive.Audio.ERole]::eMultimedia)
    [TransLive.Audio.DevicePolicy]::SetDefaultEndpointId($CaptureCommunicationsId, [TransLive.Audio.ERole]::eCommunications)
    [TransLive.Audio.DevicePolicy]::SetDefaultEndpointId($RenderConsoleId, [TransLive.Audio.ERole]::eConsole)
    [TransLive.Audio.DevicePolicy]::SetDefaultEndpointId($RenderMultimediaId, [TransLive.Audio.ERole]::eMultimedia)
    [TransLive.Audio.DevicePolicy]::SetDefaultEndpointId($RenderCommunicationsId, [TransLive.Audio.ERole]::eCommunications)
    Emit-Result @{ ok = $true }
    exit 0
  }

  [TransLive.Audio.DevicePolicy]::SetDefaultCommunicationsId($CaptureId)
  [TransLive.Audio.DevicePolicy]::SetDefaultCommunicationsId($RenderId)
  Emit-Result @{ ok = $true }
} catch {
  # The Electron adapter only exposes this stable code, not local system detail.
  Emit-Result @{ ok = $false; code = "POLICY_CONFIG_UNAVAILABLE"; detail = $_.Exception.Message }
}
