<#
.SYNOPSIS
  Takes a verified backup of the Seyirlik database, and records it.

.DESCRIPTION
  The contract is docs/backup-and-restore.md. In order:

    1. Read the live facts (table count, migration count, newest migration)
       before dumping, so a mismatch afterwards is evidence about the dump.
    2. pg_dump -Fc into a new directory under the backup root.
    3. Copy the configuration and the secrets file beside it: a dump without
       its configuration cannot be restored into a working server.
    4. Restore the dump into a scratch database and count its tables. The
       scratch name is checked against the production name first, and the
       scratch database is dropped afterwards whatever happened.
    5. Write manifest.json, and hand it to scripts/record-backup-run.ts, which
       records the run and tells the alert service how it went.
    6. Keep the newest -Keep runs and remove older ones.

  Nothing here stops, restarts or locks out Seyirlik. pg_dump reads a
  consistent snapshot while playback, progress and every other write carry on;
  the only thing it holds back for its few seconds is a schema change.

  Credentials travel in PG* environment variables, never on a command line
  (which any process can read), and are never written to the log.

  Installed as a nightly task by install-backup-task.ps1.
#>
param(
  [string] $BackupRoot = 'C:\ProgramData\Seyirlik\backups',
  [string] $ConfigDir = 'C:\ProgramData\Seyirlik\config',
  [string] $SecretsDir = 'C:\ProgramData\Seyirlik\secrets',
  [string] $AppRoot = 'C:\ProgramData\Seyirlik\app\current',
  [string] $PgBin = 'C:\Program Files\PostgreSQL\17\bin',
  [string] $Node = 'C:\Program Files\nodejs\node.exe',
  [string] $LogFile = 'C:\ProgramData\Seyirlik\logs\backup.log',
  [int] $Keep = 14
)

$ErrorActionPreference = 'Stop'
$startedAt = (Get-Date).ToUniversalTime()
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDir = Join-Path $BackupRoot "nightly-$stamp"
$manifest = [ordered]@{
  startedAt        = $startedAt.ToString('o')
  destinationClass = 'local-protected'
  dumpPresent      = $false
  configPresent    = $false
  secretsPresent   = $false
  verification     = 'unverified'
}

function Write-Log([string] $message) {
  $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $LogFile -Value $line
}

# Runs a PostgreSQL tool and returns its standard output; throws, with a
# classification and no connection details, if it fails.
function Invoke-Pg([string] $tool, [string[]] $arguments, [string] $failure) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & (Join-Path $PgBin $tool) @arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw [System.Exception]::new($failure) }
    return $output
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Read-EnvValue([string] $file, [string] $name) {
  $line = Get-Content -LiteralPath $file | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line.Substring($name.Length + 1)).Trim().Trim('"')
}

# Sets PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE from a postgres:// URL.
function Use-Connection([string] $url) {
  $uri = [Uri]$url
  $user, $password = $uri.UserInfo.Split(':', 2)
  $env:PGHOST = $uri.Host
  $env:PGPORT = if ($uri.Port -gt 0) { [string]$uri.Port } else { '5432' }
  $env:PGUSER = [Uri]::UnescapeDataString($user)
  $env:PGPASSWORD = if ($password) { [Uri]::UnescapeDataString($password) } else { '' }
  $env:PGDATABASE = $uri.AbsolutePath.TrimStart('/')
}

# The superuser file is a URL, "user:password", or a bare password for "postgres".
function Use-Superuser([string] $appUrl) {
  $raw = (Get-Content -LiteralPath (Join-Path $SecretsDir 'postgres-superuser') -Raw).Trim()
  $app = [Uri]$appUrl
  if ($raw -match '^postgres(ql)?://') {
    Use-Connection $raw
  } else {
    $env:PGHOST = $app.Host
    $env:PGPORT = if ($app.Port -gt 0) { [string]$app.Port } else { '5432' }
    if ($raw -match '^[^:\s]+:') {
      $user, $password = $raw.Split(':', 2)
      $env:PGUSER = $user
      $env:PGPASSWORD = $password
    } else {
      $env:PGUSER = 'postgres'
      $env:PGPASSWORD = $raw
    }
  }
  $env:PGDATABASE = 'postgres'
}

$scratch = $null
$appUrl = $null
try {
  New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
  New-Item -ItemType Directory -Path $runDir | Out-Null
  Write-Log "backup started: $runDir"

  $settingsFile = Join-Path $ConfigDir 'settings.env'
  $secretsFile = Join-Path $SecretsDir 'secrets.env'
  $appUrl = Read-EnvValue $secretsFile 'DATABASE_URL'
  if (-not $appUrl) { throw [System.Exception]::new('no-database-url') }
  Use-Connection $appUrl
  $productionName = $env:PGDATABASE

  # 1. The live facts, before the dump.
  $manifest.liveTables = [int](Invoke-Pg 'psql.exe' @('-XAtc', "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'") 'live-facts-unreadable')
  $migrations = Invoke-Pg 'psql.exe' @('-XAtc', 'SELECT count(*) || chr(124) || max(version) FROM seyirlik_migrations') 'live-facts-unreadable'
  $count, $newest = "$migrations".Split('|', 2)
  $manifest.schemaCount = [int]$count
  $manifest.schemaVersion = $newest

  # 2. The dump.
  $dump = Join-Path $runDir 'seyirlik.dump'
  Invoke-Pg 'pg_dump.exe' @('-Fc', '--no-owner', '--no-privileges', '-f', $dump) 'dump-failed' | Out-Null
  $manifest.dumpPresent = Test-Path -LiteralPath $dump
  $manifest.dumpBytes = (Get-Item -LiteralPath $dump).Length

  # 3. What a restore needs besides the dump.
  Copy-Item -LiteralPath $settingsFile -Destination (Join-Path $runDir 'settings.env')
  $manifest.configPresent = $true
  Copy-Item -LiteralPath $secretsFile -Destination (Join-Path $runDir 'secrets.env')
  $manifest.secretsPresent = $true

  # 4. The rehearsal: restore into a scratch database and count what arrived.
  $scratch = "seyirlik_verify_$($stamp -replace '-', '_')"
  if ($scratch -eq $productionName) { throw [System.Exception]::new('scratch-is-production') }
  Use-Superuser $appUrl
  Invoke-Pg 'psql.exe' @('-XAtc', "CREATE DATABASE $scratch") 'scratch-create-failed' | Out-Null
  $env:PGDATABASE = $scratch
  Invoke-Pg 'pg_restore.exe' @('--no-owner', '--no-privileges', '--exit-on-error', '-d', $scratch, $dump) 'restore-failed' | Out-Null
  $manifest.verifiedTables = [int](Invoke-Pg 'psql.exe' @('-XAtc', "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'") 'restore-unreadable')
  $manifest.verification = if ($manifest.verifiedTables -eq $manifest.liveTables -and $manifest.verifiedTables -gt 0) { 'verified' } else { 'failed' }
  if ($manifest.verification -ne 'verified') {
    $manifest.failureClass = 'table-count-mismatch'
    $manifest.failureDetail = "live $($manifest.liveTables), restored $($manifest.verifiedTables)"
  }
} catch {
  $manifest.failureClass = if ($_.Exception.Message -match '^[a-z-]+$') { $_.Exception.Message } else { 'unexpected-error' }
  if ($manifest.verification -eq 'unverified' -and $manifest.dumpPresent) { $manifest.verification = 'failed' }
  Write-Log "backup failed: $($manifest.failureClass)"
} finally {
  if ($scratch) {
    try {
      Use-Superuser $appUrl
      Invoke-Pg 'psql.exe' @('-XAtc', "DROP DATABASE IF EXISTS $scratch") 'scratch-drop-failed' | Out-Null
    } catch {
      Write-Log "scratch database $scratch could not be dropped"
    }
  }
  foreach ($name in 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
}

# 5. The record, and the alert that comes with it.
$manifest.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
$manifestPath = Join-Path $runDir 'manifest.json'
# Without a byte-order mark: Windows PowerShell's "utf8" writes one, and JSON
# parsers refuse it.
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
Write-Log ("backup {0}: {1} bytes, {2}/{3} tables" -f $manifest.verification, $manifest.dumpBytes, $manifest.verifiedTables, $manifest.liveTables)

$recorded = $false
Push-Location $AppRoot
try {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $Node "--env-file=$(Join-Path $ConfigDir 'settings.env')" "--env-file=$(Join-Path $SecretsDir 'secrets.env')" --import tsx scripts/record-backup-run.ts $manifestPath 2>&1 |
    ForEach-Object { Write-Log "record: $_" }
  $recorded = $LASTEXITCODE -eq 0
  $ErrorActionPreference = $previous
} finally {
  Pop-Location
}

# 6. Retention: the newest runs stay, older ones go.
Get-ChildItem -LiteralPath $BackupRoot -Directory -Filter 'nightly-*' |
  Sort-Object Name -Descending |
  Select-Object -Skip $Keep |
  ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
    Write-Log "removed old backup $($_.Name)"
  }

# A run that was not verified, or not recorded, is a failed task: nothing else
# would ever say so.
if ($manifest.verification -ne 'verified' -or -not $recorded) { exit 1 }
