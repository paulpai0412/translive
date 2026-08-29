$ErrorActionPreference = 'Stop'
$vmDir = 'C:\Program Files (x86)\VB\Voicemeeter'
$vmExe = Join-Path $vmDir 'voicemeeterpro_x64.exe'
$env:PATH = "$vmDir;$env:PATH"

if (-not (Get-Process voicemeeterpro_x64 -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $vmExe
    Start-Sleep -Seconds 3
}

$source = @'
using System.Runtime.InteropServices;
public static class VoiceMeeterRemote {
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

Add-Type -TypeDefinition $source
$login = [VoiceMeeterRemote]::VBVMR_Login()
if ($login -lt 0) { throw "VoiceMeeter Remote login failed: $login" }
Start-Sleep -Milliseconds 500

# VAIO (Strip 3): meeting speaker input -> B1 recording endpoint -> TransLive RX.
# AUX  (Strip 4): TransLive TX output -> B2 recording endpoint -> meeting microphone.
$settings = [ordered]@{
    'Strip[3].A1' = 0; 'Strip[3].A2' = 0; 'Strip[3].A3' = 0; 'Strip[3].A4' = 0; 'Strip[3].A5' = 0
    'Strip[3].B1' = 1; 'Strip[3].B2' = 0; 'Strip[3].B3' = 0
    'Strip[4].A1' = 0; 'Strip[4].A2' = 0; 'Strip[4].A3' = 0; 'Strip[4].A4' = 0; 'Strip[4].A5' = 0
    'Strip[4].B1' = 0; 'Strip[4].B2' = 1; 'Strip[4].B3' = 0
}

try {
    foreach ($entry in $settings.GetEnumerator()) {
        $result = [VoiceMeeterRemote]::VBVMR_SetParameterFloat($entry.Key, [single]$entry.Value)
        if ($result -ne 0) { throw "Set $($entry.Key) failed: $result" }
    }
    Start-Sleep -Milliseconds 500
    [void][VoiceMeeterRemote]::VBVMR_IsParametersDirty()
    foreach ($entry in $settings.GetEnumerator()) {
        [single]$actual = -1
        $result = [VoiceMeeterRemote]::VBVMR_GetParameterFloat($entry.Key, [ref]$actual)
        if ($result -ne 0 -or [math]::Abs($actual - [single]$entry.Value) -gt 0.01) {
            throw "Verify $($entry.Key) failed: result=$result actual=$actual"
        }
    }
    Write-Output 'VoiceMeeter routing configured: VAIO -> B1, AUX -> B2, no physical A-bus monitoring.'
}
finally {
    [void][VoiceMeeterRemote]::VBVMR_Logout()
}
