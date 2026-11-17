# Fixes to the "Other costs" lines (Ronan, 17 Nov 2026):
#  - "Put on Xero" back up under "Invoice checked" (the new line had pushed it down a row)
#  - the line boxed with the same thick (medium) border as the clerk's block, thin lines between its columns
#  - no fill in the date cell to its left (column B / L)
# Usage: & .\scripts\fix-diary-other-costs.ps1 -In <diary.xlsx> -Out <diary.xlsx> [-Only 'November','December']
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
    $lines = 0; $moved = 0
    for ($r = 3; $r -le $last; $r++) {
      if (([string]$ws.Range("C$r").Value2) -ne $Label) { continue }
      $lines++
      foreach ($side in @(@('B', 'C', 'I'), @('L', 'M', 'S'))) {
        $ws.Range("$($side[0])$r").Interior.Pattern = -4142                       # no fill beside it
        $box = $ws.Range("$($side[1])$($r):$($side[2])$r").Borders
        foreach ($e in 7, 8, 9, 10) { $box.Item($e).LineStyle = 1; $box.Item($e).Weight = -4138 }   # medium, like the block
        $box.Item(11).LineStyle = 1; $box.Item(11).Weight = 2                    # thin between its columns
      }
      # the invoice boxes: Invoice received / Invoice checked / Put on Xero one under another again
      if (-not ([string]$ws.Range("T$r").Value2).Trim() -and ([string]$ws.Range("T$($r + 1)").Value2).Trim() -eq 'Put on Xero' -and ([string]$ws.Range("T$($r - 1)").Value2).Trim() -eq 'Invoice checked') {
        $ws.Range("T$($r + 1)").Cut($ws.Range("T$r")) | Out-Null
        $moved++
      }
    }
    "$m : $lines Other costs lines tidied, Put on Xero moved back up in $moved"
  }
  $xl.Calculation = -4105
  $xl.CalculateFull()
  $wb.Worksheets.Item($Months[0]).Activate(); $wb.Worksheets.Item($Months[0]).Range('A1').Select() | Out-Null
  $wb.SaveAs($Out, 51)
  $wb.Close($false)
  "saved $Out"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
