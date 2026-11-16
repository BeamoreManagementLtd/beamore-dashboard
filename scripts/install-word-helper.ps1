# Sets up the Word helper on this PC (Ronan, 16 Nov 2026: on the Beamore server PC, which is always on).
# The helper makes report PDFs in Word for "Approve and send" and looks up page numbers for the check's points.
# Run it by double-clicking "Install on this PC.cmd" in the same folder. It:
#   1. checks Word works and the shared Work folder is here (Google Drive for desktop)
#   2. asks once for the dashboard key and keeps it for this Windows user only (Windows encrypts it)
#   3. checks the key with the dashboard and makes a test PDF in Word
#   4. copies the helper onto this PC and sets up the task that runs it every 2 minutes
# The helper runs from its copy on this PC, not from Drive, so nobody can change what it runs by editing the Drive
# folder. To update it, run this again: it replaces the copy and the task and, if you say so, the key.
$ErrorActionPreference = "Stop"
$TaskName = "Beamore report PDFs (Word)"
$Dashboard = "https://dashboard.beamore.co.uk"
$Source = Join-Path $PSScriptRoot "word-pdf-helper.ps1"
$Dir = Join-Path $env:LOCALAPPDATA "Beamore"
$KeyFile = Join-Path $Dir "dashboard-key.dat"
$Helper = Join-Path $Dir "word-pdf-helper.ps1"
$WorkFile = Join-Path $Dir "work-folder.txt"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
function Step($m) { Write-Host ""; Write-Host "== $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host ""; Write-Host "STOPPED: $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path -LiteralPath $Source)) { Fail "word-pdf-helper.ps1 isn't next to this installer. Run it from the 'Dashboard helper' folder in Google Drive." }

Step "1. Checking Word"
try { $w = New-Object -ComObject Word.Application; $w.DisplayAlerts = 0; $ver = $w.Version; $w.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($w) }
catch { Fail "Word didn't start on this PC. Install Microsoft Word (and sign in to Office), then run this again." }
Write-Host "Word $ver works."

Step "2. Checking the Work folder in Google Drive"
# "My Drive\Work", or a shared-folder shortcut ("G:\.shortcut-targets-by-id\<id>\Work", as on the server PC); the
# right one has the Schools folder in it
$work = $null
foreach ($d in Get-PSDrive -PSProvider FileSystem) {
  $c = @(Join-Path $d.Root "My Drive\Work")
  $s = Join-Path $d.Root ".shortcut-targets-by-id"
  if (Test-Path -LiteralPath $s) { $c += Get-ChildItem -LiteralPath $s -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName "Work" } }
  foreach ($p in $c) { if (-not $work -and (Test-Path -LiteralPath $p) -and (Test-Path -LiteralPath (Join-Path $p "Schools"))) { $work = $p } }
}
if (-not $work) { Fail "Couldn't find the Work folder (with Schools in it). Check Google Drive for desktop is signed in and Work shows in File Explorer, then run this again." }
Write-Host "Found $work"
Set-Content -LiteralPath $WorkFile -Value $work
Copy-Item -LiteralPath $Source -Destination $Helper -Force
Write-Host "Helper copied to $Helper"

Step "3. The dashboard key"
if (Test-Path -LiteralPath $KeyFile) {
  $again = Read-Host "A key is already saved on this PC. Replace it? (y/N)"
  if ($again -notmatch '^[yY]') { $keep = $true }
}
if (-not $keep) {
  Write-Host "Paste the dashboard key: CRON_SECRET, from Vercel > beamore-dashboard > Settings > Environment Variables."
  Write-Host "(It won't show as you paste. Right-click pastes in this window.)"
  $sec = Read-Host "Key" -AsSecureString
  if ($sec.Length -lt 8) { Fail "That key looks too short." }
  $sec | ConvertFrom-SecureString | Set-Content -LiteralPath $KeyFile
}
$secret = [Net.NetworkCredential]::new("", (Get-Content -LiteralPath $KeyFile | ConvertTo-SecureString)).Password
try { $q = Invoke-RestMethod -Uri "$Dashboard/api/reports/pdf-queue" -Headers @{ Authorization = "Bearer $secret"; "X-Helper-PC" = $env:COMPUTERNAME } -TimeoutSec 60 }
catch { Remove-Item -LiteralPath $KeyFile -ErrorAction SilentlyContinue; Fail "The dashboard didn't accept that key ($($_.Exception.Message)). Run this again and paste it carefully." }
Write-Host "The dashboard accepted the key ($(@($q.jobs).Count) report(s) waiting for a PDF right now)."

Step "4. Test PDF in Word"
$docx = Join-Path $env:TEMP "beamore-helper-test.docx"; $pdf = Join-Path $env:TEMP "beamore-helper-test.pdf"
Remove-Item -LiteralPath $docx, $pdf -ErrorAction SilentlyContinue
Write-Host "(Usually 10-20 seconds. Gives up after 2 minutes.)"
# run apart, with a time limit: a first-run question in Word (privacy, sign-in, licence) sits on a hidden window and
# would otherwise wait for ever (the server PC, 16 Nov 2026)
$testScript = Join-Path $env:TEMP "beamore-helper-test.ps1"
@"
`$w = New-Object -ComObject Word.Application
try { `$w.Visible = `$false; `$w.DisplayAlerts = 0; `$d = `$w.Documents.Add(); `$d.Content.Text = 'Beamore Word helper test'; `$d.SaveAs2('$docx', 16); `$d.Close(0) } finally { `$w.Quit() }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '$Helper' -Test '$docx' -TestOut '$pdf' | Out-Null
"@ | Set-Content -LiteralPath $testScript
$wordBefore = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object Id)
$p = Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$testScript`"" -WindowStyle Hidden -PassThru
if (-not $p.WaitForExit(120000)) {
  $p | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $wordBefore -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
  Fail "Word is waiting for an answer it can't show. Open Word from the Start menu, answer its questions (privacy, sign-in, licence), open a blank document, close Word, then run this again."
}
Remove-Item -LiteralPath $testScript -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $pdf)) { Fail "Word didn't make the test PDF. Open Word once by hand (to finish any sign-in or first-run questions), then run this again." }
Write-Host "Test PDF made."
Remove-Item -LiteralPath $docx, $pdf -ErrorAction SilentlyContinue

Step "5. Setting up the task (every 2 minutes, while this user is signed in)"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Helper`" -Once"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 20
$log = Join-Path $Dir "word-pdf-helper.log"
Write-Host "Task '$TaskName' is set up and has run once."
if (Test-Path -LiteralPath $log) { Write-Host "Latest from its log:"; Get-Content -LiteralPath $log -Tail 3 }

Write-Host ""
Write-Host "All done on $env:COMPUTERNAME." -ForegroundColor Green
Write-Host "Keep this PC switched on and this Windows user signed in (locking the screen is fine; signing out stops it)."
Write-Host "Tell Claude it's installed: it will check the dashboard sees this PC, then turn off the copy on Ronan's desktop."
