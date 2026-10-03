<#
Removes what deploying leaves behind, and nothing else.

Every activation adds a release of about half a gigabyte, and nothing ever
removed one: forty of them had piled up on C: by 3 October 2026, most unable
to start against a database migrated past them. This keeps the active release
and the most recent ones before it (the rollback targets), and removes:

  - older release directories under <AppRoot>\releases;
  - release-build clones in scratch (ui-release-*) that no kept release was
    staged from, once a day old;
  - applied deploy bundles (*.bundle) and operator scripts (ops\*.ps1) in
    scratch, once a week old.

It never touches database backups, configuration, secrets, logs, or the
encode workspaces under scratch\jobs — those belong to the running services
and their own collector. A release is chosen by its own release.json, never by
name order: "2026.09.29-10" sorts before "2026.09.29-9".

Run with -WhatIf to see what would go.
#>
[CmdletBinding()]
param(
  [string] $AppRoot = 'C:\ProgramData\Seyirlik\app',
  [string] $ScratchRoot = 'C:\ProgramData\Seyirlik\scratch',
  # The active release counts towards this, so the default keeps it and the
  # two most recent before it.
  [int] $Keep = 3,
  [switch] $WhatIf
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($Keep -lt 2) { throw 'Keep must be at least 2: the active release and one to roll back to.' }

$releasesRoot = Join-Path $AppRoot 'releases'
$junction = Get-Item -LiteralPath (Join-Path $AppRoot 'current') -Force -ErrorAction SilentlyContinue
$current = if ($junction) { [string]($junction.Target | Select-Object -First 1) } else { $null }
if (-not $current -or -not (Test-Path -LiteralPath $current)) {
  # Without knowing which release is live, nothing here is safe to remove.
  throw 'The current release could not be resolved; nothing was pruned.'
}
$current = (Resolve-Path -LiteralPath $current).Path.TrimEnd('\')

function Get-StagedAt($dir) {
  $manifest = Join-Path $dir.FullName 'release.json'
  if (Test-Path -LiteralPath $manifest) {
    try {
      $parsed = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
      if ($parsed.stagedAt) { return [datetime]$parsed.stagedAt }
    }
    catch { }
  }
  return $dir.CreationTimeUtc
}

function Get-SourceCheckout($dir) {
  $manifest = Join-Path $dir.FullName 'release.json'
  if (-not (Test-Path -LiteralPath $manifest)) { return $null }
  try { return (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).sourceCheckout }
  catch { return $null }
}

function Get-Bytes($item) {
  if (-not $item.PSIsContainer) { return [double]$item.Length }
  $sum = (Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
      Measure-Object Length -Sum).Sum
  return [double]$sum
}

# Adds to $script:freed rather than returning it: everything a PowerShell
# function writes is part of what it returns, so the lines it reports would
# otherwise arrive in the sum.
function Remove-Owned($item, [string] $label) {
  $bytes = Get-Bytes $item
  if ($WhatIf) {
    Write-Output ('WOULD_REMOVE {0} {1} ({2:N2} GB)' -f $label, $item.FullName, ($bytes / 1GB))
    $script:freed += $bytes
    return
  }
  if ($item.PSIsContainer) { cmd /c "attrib -R `"$($item.FullName)\*`" /S /D >nul 2>&1" }
  Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $item.FullName) {
    Write-Output ('LEFT {0} {1}' -f $label, $item.FullName)
    return
  }
  Write-Output ('REMOVED {0} {1} ({2:N2} GB)' -f $label, $item.FullName, ($bytes / 1GB))
  $script:freed += $bytes
}

$script:freed = 0.0

# --- releases --------------------------------------------------------------
$releases = @(Get-ChildItem -LiteralPath $releasesRoot -Directory -Force |
    Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
    Sort-Object { Get-StagedAt $_ } -Descending)
$kept = @($releases | Where-Object { $_.FullName.TrimEnd('\') -eq $current })
foreach ($release in $releases) {
  if ($kept.Count -ge $Keep) { break }
  if ($kept.FullName -notcontains $release.FullName) { $kept += $release }
}
Write-Output ('KEEP_RELEASES=' + (($kept | ForEach-Object Name) -join ','))

foreach ($release in $releases) {
  if ($kept.FullName -contains $release.FullName) { continue }
  # Belt and braces: only ever a direct child of the releases directory, and
  # never the live one, whatever the list above concluded.
  if ((Split-Path -Parent $release.FullName) -ne $releasesRoot) { continue }
  if ($release.FullName.TrimEnd('\') -eq $current) { continue }
  Remove-Owned $release 'release'
}

# --- release-build clones ---------------------------------------------------
$sources = @($kept | ForEach-Object { Get-SourceCheckout $_ } | Where-Object { $_ } |
    ForEach-Object { $_.TrimEnd('\') })
$dayAgo = (Get-Date).AddDays(-1)
Get-ChildItem -LiteralPath $ScratchRoot -Directory -Force -Filter 'ui-release-*' -ErrorAction SilentlyContinue |
  Where-Object {
    -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and
    $sources -notcontains $_.FullName.TrimEnd('\') -and
    $_.LastWriteTime -lt $dayAgo
  } |
  ForEach-Object { Remove-Owned $_ 'clone' }

# --- applied bundles and operator scripts -----------------------------------
$weekAgo = (Get-Date).AddDays(-7)
Get-ChildItem -LiteralPath $ScratchRoot -File -Force -Filter '*.bundle' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt $weekAgo } |
  ForEach-Object { Remove-Owned $_ 'bundle' }
$ops = Join-Path $ScratchRoot 'ops'
if (Test-Path -LiteralPath $ops) {
  Get-ChildItem -LiteralPath $ops -File -Force -Filter '*.ps1' |
    Where-Object { $_.LastWriteTime -lt $weekAgo } |
    ForEach-Object { Remove-Owned $_ 'script' }
}

Write-Output ('{0}={1:N2} GB' -f $(if ($WhatIf) { 'WOULD_FREE' } else { 'FREED' }), ($script:freed / 1GB))
