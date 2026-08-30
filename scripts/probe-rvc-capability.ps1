# Read-only local RVC capability receipt. It never downloads, installs, loads a
# model, writes a profile, or emits executable paths, environment values, or IDs.
$ErrorActionPreference = "Stop"

function Safe-Text([object]$Value, [int]$Maximum = 160) {
  if ($null -eq $Value) { return $null }
  $text = ([string]$Value).Replace("`r", " ").Replace("`n", " ").Trim()
  if ($text.Length -eq 0) { return $null }
  return $text.Substring(0, [Math]::Min($Maximum, $text.Length))
}

function Runnable-Command([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) { return $null }
  # Windows App Execution Aliases can open Store/UI; never invoke them in a probe.
  if ([string]$command.Source -match "WindowsApps") { return $null }
  return $command
}

function Command-Version([object]$Command, [string[]]$Arguments) {
  if ($null -eq $Command) { return $null }
  try {
    return Safe-Text((& $Command.Source @Arguments 2>$null | Select-Object -First 1))
  } catch {
    return $null
  }
}

$python = Runnable-Command "python"
$ffmpeg = Runnable-Command "ffmpeg"
$pythonVersion = Command-Version $python @("--version")
$ffmpegVersion = Command-Version $ffmpeg @("-version")
$torch = @{ available = $false }
$directml = @{ available = $false }

if ($null -ne $python) {
  try {
    $packages = & $python.Source -c "import importlib.util,json; print(json.dumps({'torch': importlib.util.find_spec('torch') is not None, 'torch_directml': importlib.util.find_spec('torch_directml') is not None}))" 2>$null | Select-Object -First 1 | ConvertFrom-Json
    # find_spec reports package presence without importing torch, torch-directml,
    # an RVC model, or any model-provided Python code.
    $torch.available = $packages.torch -eq $true
    $directml.available = $packages.torch_directml -eq $true
  } catch {
    # Absence or an unprobeable package is reported as unavailable; no fallback install.
  }
}

$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$gpu = Get-CimInstance Win32_VideoController | Select-Object -First 1
$memory = Get-CimInstance Win32_ComputerSystem

[pscustomobject]@{
  platform = "win32"
  hardware = [pscustomobject]@{
    cpuName = Safe-Text $cpu.Name
    gpuName = Safe-Text $gpu.Name
    gpuDriver = Safe-Text $gpu.DriverVersion
    memoryBytes = [int64]$memory.TotalPhysicalMemory
    nvidiaPresent = [bool]($gpu.Name -match "NVIDIA")
  }
  runtime = [pscustomobject]@{
    python = [pscustomobject]@{ available = $null -ne $python; version = $pythonVersion }
    ffmpeg = [pscustomobject]@{ available = $null -ne $ffmpeg; version = $ffmpegVersion }
    torch = [pscustomobject]$torch
    directml = [pscustomobject]$directml
    # A pinned RVC runtime must be installed and verified separately. This probe
    # must not discover arbitrary model files or claim they are safe to load.
    rvc = [pscustomobject]@{ available = $false; weightsOnlyLoader = $false }
  }
} | ConvertTo-Json -Compress -Depth 4
