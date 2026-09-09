<#
.SYNOPSIS
Writes an immutable release directory from a git checkout, without touching
whatever is currently serving.

.DESCRIPTION
Step 1 of the sequence in docs/deployment-model.md. Staging is the half of a
deployment that is allowed to fail freely: nothing here is visible to a running
service, so an abort leaves production exactly as it was.

The release contents come from two different places on purpose:

  tracked source   `git archive` of an exact commit, so a release cannot
                   contain a stray edit that was never committed. This is the
                   property the validation checkout does not have — it is a
                   working tree, and a working tree is editable by anyone who
                   can reach it.

  node_modules     copied from the source checkout rather than installed,
                   because an install would resolve versions at deployment
                   time and a release must be the thing that was tested.

  dist             the built frontend, likewise copied rather than rebuilt.

The release is never edited after this script writes it. Rolling back is
therefore repointing a junction, not restoring files.
#>
[CmdletBinding()]
param(
  # The git checkout to cut the release from. Its HEAD is what gets released.
  [string] $SourceCheckout = 'C:\SeyirlikValidation\phase-0b-20260907-215500\candidate',

  # Where releases live. Its ACL is what makes the release immutable to the
  # services: they inherit ReadAndExecute here and nothing more.
  [string] $AppRoot = 'C:\ProgramData\Seyirlik\app',

  # Defaults to a dated, sequenced name. Explicit for a rehearsal.
  [string] $Version
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SourceCheckout)) { throw "source checkout not found: $SourceCheckout" }

$releases = Join-Path $AppRoot 'releases'
New-Item -ItemType Directory -Force -Path $releases | Out-Null

# A release names the day it was cut and its order within that day, so two
# releases on one day cannot collide and the sequence reads chronologically.
if (-not $Version) {
  $day = Get-Date -Format 'yyyy.MM.dd'
  $n = 1
  while (Test-Path -LiteralPath (Join-Path $releases "$day-$n")) { $n++ }
  $Version = "$day-$n"
}

$target = Join-Path $releases $Version
if (Test-Path -LiteralPath $target) { throw "release already exists, refusing to overwrite: $target" }

Push-Location $SourceCheckout
try {
  $commit = (& git rev-parse HEAD).Trim()
  $tree = (& git show -s --format=%T HEAD).Trim()
  # A release cut from a dirty tree would not be reproducible from its commit,
  # which defeats the point of recording one.
  $dirty = (& git status --porcelain) -join "`n"
  if ($dirty) { throw "source checkout has uncommitted changes; refusing to cut a release that no commit describes:`n$dirty" }

  New-Item -ItemType Directory -Force -Path $target | Out-Null

  # git archive writes only tracked files at that commit. Via a tar file
  # rather than a pipe, because PowerShell's pipeline is text and would
  # corrupt the stream.
  $tar = Join-Path ([IO.Path]::GetTempPath()) "seyirlik-release-$Version.tar"
  & git archive --format=tar -o $tar HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
  & tar.exe -xf $tar -C $target
  if ($LASTEXITCODE -ne 0) { throw 'extracting the release archive failed' }
  Remove-Item -LiteralPath $tar -Force
}
finally { Pop-Location }

# /MIR would be wrong here: the destination is new, and mirroring invites a
# delete against the wrong path if it ever is not.
foreach ($dir in 'node_modules', 'dist') {
  $from = Join-Path $SourceCheckout $dir
  if (-not (Test-Path -LiteralPath $from)) { throw "source checkout has no $dir; build or install first" }
  & robocopy $from (Join-Path $target $dir) /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  # robocopy exits 0-7 for success; 8 and above is a genuine failure.
  if ($LASTEXITCODE -ge 8) { throw "copying $dir failed (robocopy $LASTEXITCODE)" }
}

# Evidence, not intent: what this release actually is, recorded beside it so
# an operator can tell two releases apart without trusting the directory name.
$manifest = [ordered]@{
  version        = $Version
  commit         = $commit
  tree           = $tree
  sourceCheckout = $SourceCheckout
  stagedAt       = (Get-Date).ToUniversalTime().ToString('o')
  stagedBy       = "$env:USERDOMAIN\$env:USERNAME"
  nodeVersion    = (& node --version).Trim()
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $target 'RELEASE.json') -Encoding UTF8

Write-Output "STAGED=$Version"
Write-Output "PATH=$target"
Write-Output "COMMIT=$commit"
Write-Output "TREE=$tree"
