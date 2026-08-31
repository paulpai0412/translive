# Read-only RVC capability receipt. The writable runtime manifest is never a
# trust source: every path/hash comes from the packaged rvc-runtime-trust.json.
$ErrorActionPreference = "Stop"

function Safe-Text([object]$Value, [int]$Maximum = 160) {
  if ($null -eq $Value) { return $null }
  $text = ([string]$Value).Replace("`r", " ").Replace("`n", " ").Trim()
  if ($text.Length -eq 0) { return $null }
  return $text.Substring(0, [Math]::Min($Maximum, $text.Length))
}

function Safe-Path([string]$Root, [string]$Relative) {
  if (
    [string]::IsNullOrWhiteSpace($Relative) -or
    [IO.Path]::IsPathRooted($Relative) -or
    $Relative -match "(^|[\\/])\.\.([\\/]|$)"
  ) { return $null }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@([char]92, [char]47))
  $candidate = [IO.Path]::GetFullPath((Join-Path $rootFull $Relative))
  if (-not $candidate.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar)) {
    return $null
  }
  return $candidate
}

function Has-ReparsePoint([string]$Root, [string]$Path) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@([char]92, [char]47))
  $pathFull = [IO.Path]::GetFullPath($Path)
  if (-not $pathFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar)) {
    return $true
  }
  $relative = $pathFull.Substring($rootFull.Length).TrimStart([char[]]@([char]92, [char]47))
  $cursor = $rootFull
  foreach ($part in $relative -split "[\\/]" | Where-Object { $_ }) {
    $cursor = Join-Path $cursor $part
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $true }
  }
  return $false
}

function Resolve-TrustedFile([string]$Root, [object]$Entry) {
  if ($null -eq $Entry -or ([string]$Entry.sha256) -notmatch "^[a-fA-F0-9]{64}$") {
    return $null
  }
  try {
    $candidate = Safe-Path $Root ([string]$Entry.path)
    if ($null -eq $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $null
    }
    if (Has-ReparsePoint $Root $candidate) { return $null }
    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$Entry.sha256).ToLowerInvariant()) { return $null }
    return $candidate
  } catch {
    return $null
  }
}

$runtimeRoot = $null
$python = $null
$ffmpeg = $null
$torch = @{ available = $false }
$directml = @{ available = $false }
$rvc = @{ available = $false; weightsOnlyLoader = $false }
$pythonVersion = $null
$ffmpegVersion = $null

try {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or $env:LOCALAPPDATA -notmatch "^[A-Za-z]:[\\/]") {
    throw "nonlocal root"
  }
  $runtimeRoot = Join-Path $env:LOCALAPPDATA "TransLive\rvc-runtime"
  if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container) -or (Has-ReparsePoint ([IO.Path]::GetPathRoot($runtimeRoot)) $runtimeRoot)) {
    throw "unsafe root"
  }
  $trust = Get-Content -LiteralPath (Join-Path $PSScriptRoot "rvc-runtime-trust.json") -Raw | ConvertFrom-Json
  if (
    $trust.rvcCommit -ne "81eed5e8f68b6bed1789f682fe78cdd324495afc" -or
    $trust.source.hfRevision -ne "e6d0c1a17da07c33557852f9dfa2bd44cc75737d" -or
    $trust.torchVersion -ne "2.4.1+cpu" -or
    $trust.directmlVersion -ne "0.2.5.dev240914"
  ) { throw "packaged trust mismatch" }
  $python = Resolve-TrustedFile $runtimeRoot $trust.python
  $ffmpeg = Resolve-TrustedFile $runtimeRoot $trust.ffmpeg
  $runner = Resolve-TrustedFile $runtimeRoot $trust.runner
  $ffprobe = Resolve-TrustedFile $runtimeRoot $trust.ffprobe
  $sourceFiles = @($trust.source.files | ForEach-Object { Resolve-TrustedFile $runtimeRoot $_ })
  $assetFiles = @($trust.assets.files | ForEach-Object { Resolve-TrustedFile $runtimeRoot $_ })
  if (
    $null -eq $python -or $null -eq $ffmpeg -or $null -eq $ffprobe -or $null -eq $runner -or
    $sourceFiles.Count -ne @($trust.source.files).Count -or $sourceFiles -contains $null -or
    $assetFiles.Count -ne @($trust.assets.files).Count -or $assetFiles -contains $null
  ) { throw "runtime trust verification failed" }
  $pythonReceipt = & (Join-Path $PSScriptRoot "verify-rvc-python.ps1") -PythonPath $python | ConvertFrom-Json
  if ($pythonReceipt.verified -ne $true) { throw "python trust" }
  $pythonVersion = Safe-Text((& $python --version 2>$null | Select-Object -First 1))
  $ffmpegVersion = Safe-Text((& $ffmpeg -version 2>$null | Select-Object -First 1))
  if ($pythonVersion -notmatch "^Python 3\.12" -or $ffmpegVersion -notmatch "^ffmpeg version 9\.0\.1") {
    throw "version mismatch"
  }
  $packages = & $python -I -B -c "import importlib.metadata as m,importlib.util,json; print(json.dumps({'torch':m.version('torch') if importlib.util.find_spec('torch') else '', 'torch_directml':m.version('torch-directml') if importlib.util.find_spec('torch_directml') else ''}))" 2>$null | Select-Object -First 1 | ConvertFrom-Json
  $torch.available = $packages.torch -eq $trust.torchVersion
  $directml.available = $packages.torch_directml -eq $trust.directmlVersion
  $rvc.available = $torch.available -and $null -ne $runner
  $rvc.weightsOnlyLoader = $rvc.available
} catch {
  # Fail closed. No executable path, manifest content, model path or ACL detail leaves this process.
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
    rvc = [pscustomobject]$rvc
  }
} | ConvertTo-Json -Compress -Depth 4
