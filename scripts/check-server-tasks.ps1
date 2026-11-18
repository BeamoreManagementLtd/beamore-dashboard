# What keeps starting PowerShell on this PC? (Ronan, 18 Nov 2026: windows popping up every few seconds on the server.)
# Lists scheduled tasks that repeat or run PowerShell/scripts, and the PowerShell windows running right now.
# Changes nothing. Run it by double-clicking "Check what keeps popping up.cmd".
Write-Host "== Scheduled tasks that repeat, or that run PowerShell or a script" -ForegroundColor Cyan
Get-ScheduledTask | Where-Object { $_.State -ne "Disabled" -and $_.TaskPath -notlike "\Microsoft\*" } | ForEach-Object {
  $t = $_
  $rep = ($t.Triggers | ForEach-Object { $_.Repetition.Interval }) -join ", "
  $act = ($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join " | "
  if ($rep -or $act -match "powershell|pwsh|cmd|node|python|wscript|cscript|codex|claude") {
    [pscustomobject]@{ Task = "$($t.TaskPath)$($t.TaskName)"; Repeats = $(if ($rep) { $rep } else { "-" }); Runs = $act.Substring(0, [Math]::Min(150, $act.Length)) }
  }
} | Format-Table -AutoSize -Wrap

Write-Host "== PowerShell / script processes running now (and what started them)" -ForegroundColor Cyan
$all = Get-CimInstance Win32_Process
$all | Where-Object { $_.Name -match "powershell|pwsh|cmd\.exe|node|python|wscript|conhost" } | ForEach-Object {
  $parent = $all | Where-Object ProcessId -eq $_.ParentProcessId | Select-Object -First 1
  [pscustomobject]@{ Process = $_.Name; Started = $_.CreationDate; Parent = $(if ($parent) { $parent.Name } else { "?" }); Command = $(if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(140, $_.CommandLine.Length)) } else { "" }) }
} | Sort-Object Started -Descending | Select-Object -First 25 | Format-Table -AutoSize -Wrap
Write-Host ""
Write-Host "Nothing was changed. Send Claude a photo or copy of this window." -ForegroundColor Green
Read-Host "Press Enter to close"
