param(
  [Parameter(Mandatory = $true)]
  [string]$PythonPath
)

$ErrorActionPreference = "Stop"

function Safe-Result([bool]$Verified) {
  @{ verified = $Verified } | ConvertTo-Json -Compress
}

function Test-TrustedRegularFile([string]$Root, [string]$RelativePath, [string]$ExpectedHash) {
  if ($RelativePath -match '(^[\\/])|(^[A-Za-z]:)|(^|[\\/])\.\.([\\/]|$)') {
    throw "path"
  }
  $path = Join-Path $Root $RelativePath
  $item = Get-Item -LiteralPath $path -Force
  if (
    -not $item.PSIsContainer -and
    -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
    ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -eq $ExpectedHash.ToLowerInvariant())
  ) {
    return $path
  }
  throw "receipt"
}

function Get-RecordTreeHash([object[]]$Records) {
  $nul = [char]0
  $lf = [char]10
  $text = ($Records | ForEach-Object { "$($_.path)$nul$($_.sha256)$lf" }) -join ""
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

try {
  $trust = Get-Content -LiteralPath (Join-Path $PSScriptRoot "rvc-runtime-trust.json") -Raw | ConvertFrom-Json
  if ($trust.python.path -ne ".venv/Scripts/python.exe" -or -not $trust.python.sha256) {
    throw "invalid packaged trust"
  }
  $item = Get-Item -LiteralPath $PythonPath -Force
  $runtimeRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $item.FullName))
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "reparse"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
  if (
    $signature.Status -ne "Valid" -or
    $signature.SignerCertificate.Subject -notmatch 'Python Software Foundation'
  ) {
    throw "signature"
  }
  $version = [string]$item.VersionInfo.ProductVersion
  if (-not $version.StartsWith([string]$trust.python.version)) {
    throw "version"
  }
  if (
    ((Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) -ne
    ([string]$trust.python.sha256).ToLowerInvariant()
  ) {
    throw "hash"
  }
  $records = @($trust.pythonEnvironment.records)
  if ($records.Count -lt 20 -or -not $trust.pythonEnvironment.treeSha256) {
    throw "records"
  }
  foreach ($record in $records) {
    [void](Test-TrustedRegularFile $runtimeRoot ([string]$record.path) ([string]$record.sha256))
  }
  if ((Get-RecordTreeHash $records) -ne ([string]$trust.pythonEnvironment.treeSha256).ToLowerInvariant()) {
    throw "record-tree"
  }
  $isolated = & $item.FullName -I -B -c "import json,sys; print(json.dumps({'isolated':bool(sys.flags.isolated),'safe_path':bool(sys.flags.safe_path)}))" 2>$null | Select-Object -First 1 | ConvertFrom-Json
  if ($isolated.isolated -ne $true -or $isolated.safe_path -ne $true) {
    throw "isolated"
  }
  Safe-Result $true
} catch {
  # Never disclose executable paths, ACLs, signatures, or machine details.
  Safe-Result $false
}
