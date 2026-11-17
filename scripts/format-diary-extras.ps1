# Tidying the diary (Ronan, 17 Nov 2026):
#  - borders round each clerk's "Other costs (what for:)" line, on both sides, so it reads as a box
#  - a "Comments" column (AA) beside each client invoice table (W:Z), for notes or extras to add to the client's invoice:
#    the Totals column's formatting (borders, colours) copied across, then headed "Comments" and left empty
# Usage: & .\scripts\format-diary-extras.ps1 -In <diary.xlsx> -Out <diary.xlsx> [-Only 'November','December']
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out, [string[]]$Only = @())
$ErrorActionPreference = 'Stop'
$Months = @('January','February','March','April','May','June','July','August','September','October','November','December')
if ($Only.Count) { $Months = @($Months | Where-Object { $Only -contains $_ }) }
$Label = 'Other costs (what for:)'
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
try {
  $wb = $xl.Workbooks.Open($In)
  $xl.Calculation = -4135
  foreach ($m in $Months) {
    $ws = $wb.Worksheets.Item($m)
    $last = $ws.UsedRange.Row + $ws.UsedRange.Rows.Count
    # 1. Other costs lines: find them by their label in column C (grey side) / M (salmon side)
    $boxes = 0
    for ($r = 3; $r -le $last; $r++) {
      foreach ($pair in @(@('C', 'I'), @('M', 'S'))) {
        if (([string]$ws.Range("$($pair[0])$r").Value2) -eq $Label) {
          $b = $ws.Range("$($pair[0])$($r):$($pair[1])$r").Borders
          foreach ($e in 7, 8, 9, 10, 11) { $b.Item($e).LineStyle = 1; $b.Item($e).Weight = 2 }  # left, top, bottom, right, inside verticals: thin
          $boxes++
        }
      }
    }
    # 2. client invoice tables: a header row with "No of days" in X; the table runs down to its "Total" row (Y)
    $tables = 0
    for ($r = 1; $r -le 499; $r++) {
      if (([string]$ws.Range("X$r").Value2).Trim() -ne 'No of days') { continue }
      $end = $r
      for ($k = $r + 1; $k -le $r + 80; $k++) { if (([string]$ws.Range("Y$k").Value2).Trim() -eq 'Total') { $end = $k; break } }
      if (([string]$ws.Range("AA$r").Value2).Trim() -eq 'Comments') { continue }
      $ws.Range("Z$($r):Z$end").Copy() | Out-Null
      $ws.Range("AA$($r):AA$end").PasteSpecial(-4122) | Out-Null   # formats only
      $ws.Range("AA$($r):AA$end").ClearContents() | Out-Null
      $ws.Range("AA$r").Value2 = 'Comments'
      $ws.Range("AA$($r + 1):AA$end").HorizontalAlignment = -4131; $ws.Range("AA$($r + 1):AA$end").NumberFormat = '@'
      $b = $ws.Range("AA$($r):AA$end").Borders
      foreach ($e in 7, 8, 9, 10, 12) { $b.Item($e).LineStyle = 1; $b.Item($e).Weight = 2 }   # box and lines between rows
      $tables++
    }
    $ws.Columns('AA').ColumnWidth = 34
    $xl.CutCopyMode = 0
    "$m : $boxes Other costs boxes, $tables client tables with a Comments column"
  }
  $xl.Calculation = -4105
  $xl.CalculateFull()
  $wb.Worksheets.Item($Months[0]).Activate(); $wb.Worksheets.Item($Months[0]).Range('A1').Select() | Out-Null
  $wb.SaveAs($Out, 51)
  $wb.Close($false)
  "saved $Out"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
