# Beamore report PDFs, made with Word (Ronan, 15 Nov 2026: Google spoils the layout).
# Runs on the Beamore server PC (always on; Word + Google Drive for desktop) every 2 minutes from Task Scheduler, set up
# by install-word-helper.ps1, which copies this file onto that PC (run the installer again to update it):
#   1. asks the dashboard which approved reports are waiting for a PDF
#   2. opens a COPY of each in Word, accepts any tracked changes left, removes comments, saves it as PDF
#   3. puts the PDF next to the report in the Google Drive folder (Drive for desktop uploads it)
#   4. tells the dashboard, which then emails it from the checker's own email
#   5. looks up the page numbers of the points found in newly checked reports, for the dashboard
# Reports are only ever opened as throwaway copies here; the Word file in Drive is never changed.
param([switch]$Once, [string]$Test, [string]$TestOut)

$ErrorActionPreference = "Stop"
$Dashboard = "https://dashboard.beamore.co.uk"
# the shared Work folder through Google Drive for desktop: the one the installer found (work-folder.txt), else
# "My Drive\Work" or a shared-folder shortcut ("<drive>\.shortcut-targets-by-id\<id>\Work", as on the server PC),
# on whichever letter Drive has
function Find-WorkFolder {
  foreach ($d in Get-PSDrive -PSProvider FileSystem) {
    $c = @(Join-Path $d.Root "My Drive\Work")
    $s = Join-Path $d.Root ".shortcut-targets-by-id"
    if (Test-Path -LiteralPath $s) { $c += Get-ChildItem -LiteralPath $s -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { Join-Path $_.FullName "Work" } }
    foreach ($p in $c) { if ((Test-Path -LiteralPath $p) -and (Test-Path -LiteralPath (Join-Path $p "Schools"))) { return $p } }
  }
  return $null
}
$WorkFile = Join-Path $env:LOCALAPPDATA "Beamore\work-folder.txt"
$Root = if (Test-Path -LiteralPath $WorkFile) { (Get-Content -LiteralPath $WorkFile -Raw).Trim() } else { "G:\My Drive\Work" }
if (-not (Test-Path -LiteralPath $Root)) { $found = Find-WorkFolder; if ($found) { $Root = $found } }
$Log = Join-Path $env:LOCALAPPDATA "Beamore\word-pdf-helper.log"
# the dashboard key: saved by the installer for this Windows user only (Windows encrypts it), or, on the PC with the
# dashboard's code, from its .env.local
$KeyFile = Join-Path $env:LOCALAPPDATA "Beamore\dashboard-key.dat"
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

# Page numbers for a checked report's points (Ronan, 16 Nov 2026: listed on the dashboard by page, not as comments in
# the Word file). On a throwaway COPY: the spelling changes are rejected so the text matches the words the dashboard
# kept, then each point's words are found and the page Word puts them on is noted.
function Get-Pages([string]$Docx, $Find) {
  $tmp = Join-Path $env:TEMP ("beamore-" + [guid]::NewGuid().ToString() + ".docx")
  Copy-Item -LiteralPath $Docx -Destination $tmp
  $before = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object Id)
  $word = New-Object -ComObject Word.Application
  $pages = @{}
  try {
    $word.Visible = $false; $word.DisplayAlerts = 0
    $doc = $word.Documents.Open($tmp)
    $doc.TrackRevisions = $false
    if ($doc.Revisions.Count -gt 0) { $doc.Revisions.RejectAll() }
    if ($doc.Comments.Count -gt 0) { $doc.DeleteAllComments() }
    $doc.Repaginate()
    foreach ($f in $Find) {
      $page = $null
      # the words as kept, then shorter if Word can't match them all (a tab, a field, a symbol in the middle)
      $words = ($f.near -split '\s+')
      foreach ($n in (@($words.Count, 6, 3) | Where-Object { $_ -le $words.Count } | Select-Object -Unique)) {
        $text = (($words | Select-Object -First $n) -join ' ').Replace('^', '^^')
        if ($text.Length -lt 4) { continue }
        $rng = $doc.Content
        $fd = $rng.Find; $fd.ClearFormatting(); $fd.Text = $text; $fd.MatchCase = $false; $fd.MatchWildcards = $false; $fd.Forward = $true; $fd.Wrap = 0
        if ($fd.Execute()) { $page = [int]$rng.Information(3); break }   # 3 = page number of the found text
      }
      $pages["$($f.k)"] = $page
    }
    $total = [int]$doc.ComputeStatistics(2)   # 2 = pages
    try { $doc.Saved = $true } catch { }
    return @{ pages = $pages; total = $total }
  } finally {
    try { $word.Quit() } catch { }
    try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch { }
    Start-Sleep -Seconds 2
    Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
}

if ($Test) { Convert-WithWord $Test $TestOut; "PDF: $TestOut"; exit }

# the dashboard's key (the same one its scheduled jobs use)
if (Test-Path -LiteralPath $KeyFile) {
  $secret = [Net.NetworkCredential]::new("", (Get-Content -LiteralPath $KeyFile | ConvertTo-SecureString)).Password
} else {
  $envFile = Join-Path $PSScriptRoot "..\.env.local"
  $secret = ((Get-Content $envFile | Where-Object { $_ -match '^CRON_SECRET=' }) -replace '^CRON_SECRET=', '').Trim('"')
}
# the PC's name goes with each request, so the dashboard can show which computer is making the PDFs
$headers = @{ Authorization = "Bearer $secret"; "X-Helper-PC" = $env:COMPUTERNAME }

do {
  try {
    $queue = Invoke-RestMethod -Uri "$Dashboard/api/reports/pdf-queue" -Headers $headers -TimeoutSec 60
    foreach ($job in $queue.jobs) {
      try {
        # the checked report is in the report folder (older ones: in "Checked (dashboard)"); the PDF goes in the report folder
        $folder = Join-Path $Root (Join-Path $job.main_folder (Join-Path $job.project_folder $job.report_folder))
        $docx = Join-Path (Join-Path $folder $job.checked_folder) $job.file_name
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
  # then page numbers for the points on newly checked reports (PDFs first: they hold up an email)
  try {
    $pq = Invoke-RestMethod -Uri "$Dashboard/api/reports/pages-queue" -Headers $headers -TimeoutSec 60
    foreach ($job in $pq.jobs) {
      $docx = Join-Path $Root (Join-Path $job.main_folder (Join-Path $job.project_folder (Join-Path $job.report_folder $job.file_name)))
      if (-not (Test-Path -LiteralPath $docx)) { Write-Log "pages: not on this PC yet: $docx"; continue }
      try {
        $res = Get-Pages $docx $job.find
        $body = @{ rev = $job.rev; pages = $res.pages; total = $res.total } | ConvertTo-Json -Depth 4 -Compress
        Invoke-RestMethod -Method Post -Uri "$Dashboard/api/reports/pages-found?id=$($job.id)" -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 60 | Out-Null
        Write-Log "pages for $($job.file_name)"
      } catch {
        Write-Log "pages failed $($job.file_name): $($_.Exception.Message)"
        $body = @{ rev = $job.rev; error = $_.Exception.Message } | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post -Uri "$Dashboard/api/reports/pages-found?id=$($job.id)" -Headers $headers -ContentType "application/json" -Body $body -TimeoutSec 60 | Out-Null
      }
    }
  } catch { Write-Log "pages: dashboard not reached: $($_.Exception.Message)" }
  if (-not $Once) { Start-Sleep -Seconds 120 }
} while (-not $Once)
