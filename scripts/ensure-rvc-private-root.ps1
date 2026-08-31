param(
  [Parameter(Mandatory = $true)]
  [string]$Directory
)

$ErrorActionPreference = "Stop"

function Fail-Closed() {
  @{ ready = $false } | ConvertTo-Json -Compress
  exit 0
}

function Sid([string]$Value) {
  return New-Object Security.Principal.SecurityIdentifier($Value)
}

try {
  if ($Directory -notmatch "^[A-Za-z]:[\\/]") { Fail-Closed }
  if ($Directory -match "^\\\\|^\\\\[.?]\\") { Fail-Closed }
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $root = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]@([char]92, [char]47))
  $drive = [IO.Path]::GetPathRoot($root)
  $relative = $root.Substring($drive.Length).TrimStart([char[]]@([char]92, [char]47))
  $cursor = $drive
  foreach ($part in $relative -split "[\\/]" | Where-Object { $_ }) {
    $cursor = Join-Path $cursor $part
    $item = Get-Item -LiteralPath $cursor -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail-Closed }
  }

  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = Sid "S-1-5-18"
  $administratorsSid = Sid "S-1-5-32-544"
  $allowed = @($currentSid.Value, $systemSid.Value, $administratorsSid.Value)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $full = [Security.AccessControl.FileSystemRights]::FullControl
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
      $sid, $full, $inheritance, $propagation, $allow
    )))
  }
  Set-Acl -LiteralPath $root -AclObject $security

  # Reset descendants to the now-private inheritable root DACL. Failure is fatal;
  # leaving an explicit broad ACE on a model/recording file is not acceptable.
  $children = Join-Path $root "*"
  if (Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop | Select-Object -First 1) {
    & icacls.exe $children /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail-Closed }
  }

  $rootAcl = Get-Acl -LiteralPath $root
  if (-not $rootAcl.AreAccessRulesProtected) { Fail-Closed }
  foreach ($entry in $rootAcl.Access) {
    if ($entry.AccessControlType -ne $allow) { continue }
    $sidValue = $entry.IdentityReference.Translate(
      [Security.Principal.SecurityIdentifier]
    ).Value
    if ($allowed -notcontains $sidValue) { Fail-Closed }
  }

  @{ ready = $true } | ConvertTo-Json -Compress
} catch {
  # No local path, account, ACL or filesystem detail is returned.
  Fail-Closed
}
