# Some clerks' blocks priced their visits at the client rate (Rates column 2) instead of the clerk rate (column 3):
# John Munro, Lewis Lucas, Robert Reid in 2026 - a mistake (Ronan, 15 Nov 2026). Puts every cost cell in those clerks'
# blocks back to column 3, on both sides, in every month. Ronan's own block is meant to use column 2 and isn't touched.
# Usage: powershell -File scripts/fix-diary-clerk-rates.ps1 -In <diary.xlsx> -Out <diary.xlsx> [-Clerks 'John Munro','Lewis Lucas','Robert Reid']
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out, [string[]]$Clerks = @('John Munro', 'Lewis Lucas', 'Robert Reid'))
$ErrorActionPreference = 'Stop'
$Months = @('January','February','March','April','May','June','July','August','September','October','November','December')
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
try {
  $wb = $xl.Workbooks.Open($In)
  $xl.Calculation = -4135
  $total = 0
  foreach ($m in $Months) {
    $ws = $null; try { $ws = $wb.Worksheets.Item($m) } catch { continue }
    $last = $ws.UsedRange.Row + $ws.UsedRange.Rows.Count
    $n = 0
    for ($r = 3; $r -le $last; $r++) {
      $name = ([string]$ws.Cells($r, 1).Value2 -split "`n")[0].Trim()
      if (-not ($Clerks -contains $name)) { continue }
      # the block: from its name row to the next "1st location" header
      for ($b = $r; $b -le $last -and -not ($b -gt $r -and [string]$ws.Cells($b, 3).Value2 -match '^1st location$'); $b++) {
        foreach ($c in 4, 6, 8, 14, 16, 18) {
          $cell = $ws.Cells($b, $c)
          if ($cell.HasFormula -and $cell.Formula -match 'VLOOKUP\([A-Z]+\d+,Rates!\$A\$1:\$C\$\d+,2,FALSE\)') { $cell.Formula = $cell.Formula -replace '(VLOOKUP\([A-Z]+\d+,Rates!\$A\$1:\$C\$\d+),2,FALSE\)', '$1,3,FALSE)'; $n++ }
        }
      }
      $r = $b - 1
    }
    "$m : $n cost cells changed to the clerk rate"
    $total += $n
  }
  $xl.Calculation = -4105; $xl.CalculateFull()
  $wb.SaveAs($Out, 51); $wb.Close($false)
  "saved $Out ($total cells)"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
