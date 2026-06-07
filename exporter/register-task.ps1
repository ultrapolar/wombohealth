# Registers a Windows Scheduled Task that runs the Obsidian exporter every morning.
# Run once (normal PowerShell, no admin needed for a per-user task):
#   powershell -ExecutionPolicy Bypass -File .\register-task.ps1
# Re-run to update. Trigger manually any time with:
#   schtasks /run /tn "TRMNL Health Export"
param(
    [string]$Time = "07:30",
    [string]$TaskName = "TRMNL Health Export"
)
$ErrorActionPreference = "Stop"

$script = Join-Path $PSScriptRoot "export.py"
if (-not (Test-Path $script)) { throw "export.py not found next to this script." }

$python = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $python) { throw "python not found on PATH." }

$action   = New-ScheduledTaskAction -Execute $python -Argument "`"$script`"" -WorkingDirectory $PSScriptRoot
$trigger  = New-ScheduledTaskTrigger -Daily -At $Time
# StartWhenAvailable => if the PC was off at $Time, run at the next opportunity (pairs with backfill_days).
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Daily Ultrahuman -> Obsidian health export" -Force | Out-Null

Write-Host "Registered '$TaskName' to run python $script daily at $Time."
Write-Host "Test now:  schtasks /run /tn `"$TaskName`""
Write-Host "Remove:    Unregister-ScheduledTask -TaskName `"$TaskName`" -Confirm:`$false"
