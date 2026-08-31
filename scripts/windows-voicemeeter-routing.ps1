param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("snapshot", "apply", "restore")]
  [string]$Action,
  [string]$ValuesBase64
)

$ErrorActionPreference = "Stop"
$vmDirectory = "C:\Program Files (x86)\VB\Voicemeeter"
$vmExecutable = Join-Path $vmDirectory "voicemeeterpro_x64.exe"
$remoteDll = Join-Path $vmDirectory "VoicemeeterRemote64.dll"
$loggedIn = $false

$keys = @(
  "Strip[3].A1", "Strip[3].A2", "Strip[3].A3", "Strip[3].A4",
  "Strip[3].A5", "Strip[3].B1", "Strip[3].B2", "Strip[3].B3",
  "Strip[4].A1", "Strip[4].A2", "Strip[4].A3", "Strip[4].A4",
  "Strip[4].A5", "Strip[4].B1", "Strip[4].B2", "Strip[4].B3"
)
$target = [ordered]@{}
foreach ($key in $keys) { $target[$key] = 0 }
$target["Strip[3].B1"] = 1
$target["Strip[4].B2"] = 1

function Emit([hashtable]$Value) {
  $Value | ConvertTo-Json -Compress -Depth 4
}

function Fail-Closed() {
  Emit @{ ok = $false; code = "VOICEMEETER_ROUTING_FAILED" }
  exit 0
}

function Read-Values() {
  $result = [ordered]@{}
  foreach ($key in $keys) {
    [single]$value = -1
    $status = [TransLiveVoiceMeeterRemote]::VBVMR_GetParameterFloat(
      $key,
      [ref]$value
    )
    if ($status -ne 0) { throw "read failed" }
    $result[$key] = if ([math]::Abs($value) -lt 0.5) { 0 } else { 1 }
  }
  return $result
}

function Normalize-RestoreValues([string]$Encoded) {
  if ([string]::IsNullOrWhiteSpace($Encoded)) { throw "missing values" }
  $json = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String($Encoded)
  )
  $parsed = $json | ConvertFrom-Json
  if ($null -eq $parsed) { throw "invalid values" }
  $properties = @($parsed.PSObject.Properties)
  if ($properties.Count -ne $keys.Count) { throw "invalid values" }
  $normalized = [ordered]@{}
  foreach ($key in $keys) {
    $property = $parsed.PSObject.Properties[$key]
    if ($null -eq $property) { throw "invalid values" }
    $value = [int]$property.Value
    if ($value -ne 0 -and $value -ne 1) { throw "invalid values" }
    $normalized[$key] = $value
  }
  foreach ($property in $properties) {
    if ($keys -notcontains $property.Name) { throw "invalid values" }
  }
  return $normalized
}

function Set-Values([hashtable]$Values) {
  foreach ($key in $keys) {
    $status = [TransLiveVoiceMeeterRemote]::VBVMR_SetParameterFloat(
      $key,
      [single]$Values[$key]
    )
    if ($status -ne 0) { throw "write failed" }
  }
  Start-Sleep -Milliseconds 350
  [void][TransLiveVoiceMeeterRemote]::VBVMR_IsParametersDirty()
  $actual = Read-Values
  foreach ($key in $keys) {
    if ([int]$actual[$key] -ne [int]$Values[$key]) {
      throw "verification failed"
    }
  }
}

try {
  if (-not (Test-Path -LiteralPath $remoteDll -PathType Leaf)) {
    Fail-Closed
  }
  if (-not (Test-Path -LiteralPath $vmExecutable -PathType Leaf)) {
    Fail-Closed
  }
  if (-not (Get-Process -Name "voicemeeterpro_x64" -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $vmExecutable | Out-Null
    Start-Sleep -Seconds 3
  }
  $env:PATH = "$vmDirectory;$env:PATH"
  Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class TransLiveVoiceMeeterRemote {
  [DllImport("VoicemeeterRemote64.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int VBVMR_Login();
  [DllImport("VoicemeeterRemote64.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int VBVMR_Logout();
  [DllImport("VoicemeeterRemote64.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern int VBVMR_SetParameterFloat(string name, float value);
  [DllImport("VoicemeeterRemote64.dll", CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Ansi)]
  public static extern int VBVMR_GetParameterFloat(string name, ref float value);
  [DllImport("VoicemeeterRemote64.dll", CallingConvention = CallingConvention.Cdecl)]
  public static extern int VBVMR_IsParametersDirty();
}
'@
  $login = [TransLiveVoiceMeeterRemote]::VBVMR_Login()
  if ($login -lt 0) { throw "login failed" }
  $loggedIn = $true
  Start-Sleep -Milliseconds 500

  if ($Action -eq "snapshot") {
    Emit @{ ok = $true; values = Read-Values }
    exit 0
  }
  if ($Action -eq "apply") {
    Set-Values $target
    Emit @{ ok = $true }
    exit 0
  }
  $restoreValues = Normalize-RestoreValues $ValuesBase64
  Set-Values $restoreValues
  Emit @{ ok = $true }
} catch {
  Fail-Closed
} finally {
  if ($loggedIn) { [void][TransLiveVoiceMeeterRemote]::VBVMR_Logout() }
}
