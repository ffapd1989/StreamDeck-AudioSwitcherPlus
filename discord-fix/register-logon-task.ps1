$taskName = 'Reapply Discord Set Audio Device fix'
$node = (Get-Command node -ErrorAction Stop).Source
$apply = Join-Path $PSScriptRoot 'apply.mjs'

$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$node`" `"$apply`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "Registered '$taskName': runs $apply at every logon (and just ran once)."
