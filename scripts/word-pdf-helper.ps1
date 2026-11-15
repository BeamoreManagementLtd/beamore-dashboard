# Beamore report PDFs, made with Word (Ronan, 15 Nov 2026: Google spoils the layout).
# Runs on the office PC (Word + Google Drive for desktop) every 2 minutes from Task Scheduler:
#   1. asks the dashboard which approved reports are waiting for a PDF
#   2. opens a COPY of each in Word, accepts any tracked changes left, removes comments, saves it as PDF
#   3. puts the PDF next to the report in the Google Drive folder (Drive for desktop uploads it)
#   4. tells the dashboard, which then emails it from the checker's own email
# The clerk's Word file itself is never opened or changed here.
param([switch]$Once, [string]$Test, [string]$TestOut)

$ErrorActionPreference = "Stop"
$Dashboard = "https://dashboard.beamore.co.uk"
$Root = "G:\My Drive\Work"
$Log = Join-Path $env:LOCALAPPDATA "Beamore\word-pdf-helper.log"
New-Item -ItemType Directory -Force -Path (Split-Path $Log) | Out-Null
function Write-Log($m) { "$(Get-Date -Format s)  $m" | Add-Content -Path $Log }

function Convert-WithWord([string]$Docx, [string]$Pdf) {
  $tmp = Join-Path $env:TEMP ("beamore-" + [guid]::NewGuid().ToString() + ".docx")
  Copy-Item -LiteralPath $Docx -Destination $tmp
  $before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object Id)
  $word = New-Object -ComObject Word.Application
  try {
    $word.Visible = $false; $word.DisplayAlerts = 0
    $doc = $word.Documents.Open($tmp)
    $doc.TrackRevisions = $false
    if ($doc.Revisions.Count -gt 0) { $doc.Revisions.AcceptAll() }
    if ($doc.Comments.Count -gt 0) { $doc.DeleteAllComments() }
    try { $doc.ExportAsFixedFormat($Pdf, 17) }   # 17 = PDF
    catch { if (-not (Test-Path -LiteralPath $Pdf)) { throw } }   # Word sometimes lets go straight after saving: fine if the PDF is there
    try { $doc.Saved = $true } catch { }          # it's a throwaway copy: nothing to save
    if (-not (Test-Path -LiteralPath $Pdf) -or (Get-Item -LiteralPath $Pdf).Length -lt 1000) { throw "Word didn't produce the PDF" }
  } finally {
    try { $word.Quit() } catch { }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch { }
    # make sure the Word this started has gone (never one someone already had open)
    Start-Sleep -Seconds 2
    Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
}

if ($Test) { Convert-WithWord $Test $TestOut; "PDF: $TestOut"; exit }

# the dashboard's key (the same one its scheduled jobs use), from the dashboard folder on this PC
$envFile = Join-Path $PSScriptRoot "..\.env.local"
$secret = ((Get-Content $envFile | Where-Object { $_ -match '^CRON_SECRET=' }) -replace '^CRON_SECRET=', '').Trim('"')
$headers = @{ Authorization = "Bearer $secret" }

do {
  try {
    $queue = Invoke-RestMethod -Uri "$Dashboard/api/reports/pdf-queue" -Headers $headers -TimeoutSec 60
    foreach ($job in $queue.jobs) {
      try {
        $folder = Join-Path $Root (Join-Path $job.main_folder (Join-Path $job.project_folder $job.report_folder))
        $docx = Join-Path $folder $job.file_name
        if (-not (Test-Path -LiteralPath $docx)) { Write-Log "not on this PC yet: $docx"; continue }
        $pdfTemp = Join-Path $env:TEMP ("beamore-" + [guid]::NewGuid().ToString() + ".pdf")
        Convert-WithWord $docx $pdfTemp
        Copy-Item -LiteralPath $pdfTemp -Destination (Join-Path $folder $job.pdf_name) -Force
        Remove-Item -LiteralPath $pdfTemp -ErrorAction SilentlyContinue
        Invoke-RestMethod -Method Post -Uri "$Dashboard/api/reports/pdf-made?id=$($job.id)" -Headers $headers -TimeoutSec 60 | Out-Null
        Write-Log "made $($job.pdf_name)"
      } catch { Write-Log "failed $($job.file_name): $($_.Exception.Message)"; Invoke-RestMethod -Method Post -Uri "$Dashboard/api/reports/pdf-made?id=$($job.id)&error=$([uri]::EscapeDataString($_.Exception.Message))" -Headers $headers -TimeoutSec 60 | Out-Null }
    }
  } catch { Write-Log "dashboard not reached: $($_.Exception.Message)" }
  if (-not $Once) { Start-Sleep -Seconds 120 }
} while (-not $Once)
