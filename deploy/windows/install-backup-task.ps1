<#
.SYNOPSIS
  Schedules backup-database.ps1 to run every night.

.DESCRIPTION
  Runs as SYSTEM at 04:30, from the active release (the `current` junction),
  so a deployment updates the script it runs. At below-normal priority, with a
  30-minute ceiling, and - because this host is sometimes off or rebooting at
  that hour - catching up as soon as it can after a missed start.

  Idempotent: running it again replaces the task with the same definition.
#>
param(
  [string] $TaskName = 'Seyirlik Nightly Backup',
  [string] $Script = 'C:\ProgramData\Seyirlik\app\current\deploy\windows\backup-database.ps1',
  [string] $At = '04:30'
)

$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -MultipleInstances IgnoreNew `
  -Priority 7
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Verified nightly backup of the Seyirlik database (deploy/windows/backup-database.ps1).' `
  -Force | Out-Null
"INSTALLED=$TaskName at $At"
