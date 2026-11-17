# Two "Test" checks under the totals (Ronan, 17 Nov 2026: "move that down about 2 rows down underneath estimated profit ...
# put test back in ... if the numbers are equal, the test turns green ... not equal, red" and "we should probably have a
# test for estimate and a test for the actual"):
#   Estimated profit
#   (gap)
#   Test (actual)                 green when the two below match, red when not
#   Subby days onsite             salmon-side day slots / 2 (an Other costs amount isn't a day)
#   Client days                   the days in the client tables (unchanged)
#   (gap)
#   Test (estimate)
#   Estimated subby days (grey side)    grey-side day slots / 2
#   Estimated client days (grey side)   grey-side places that match a client table / 2
#   (gap)
#   Subcontractors incl VAT ... (moved down, formulas follow)
# Usage: & .\scripts\diary-tests.ps1 -In <diary.xlsx> -Out <diary.xlsx> [-Only 'November','December']
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out, [string[]]$Only = @())
$ErrorActionPreference = 'Stop'
$Months = @('January','February','March','April','May','June','July','August','September','October','November','December')
if ($Only.Count) { $Months = @($Months | Where-Object { $Only -contains $_ }) }
$OC = 'Other costs (what for:)'
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
function Find-Label($ws, $text) { for ($r = 499; $r -le 540; $r++) { if (([string]$ws.Range("W$r").Value2).Trim() -eq $text) { return $r } }; return 0 }
function Set-Test($ws, $t) {
  $c = $ws.Range("W$t")
  $c.FormatConditions.Delete() | Out-Null
  $red = $c.FormatConditions.Add(2, 0, "=`$X`$$($t + 1)<>`$X`$$($t + 2)"); $red.Interior.Color = 255
  $green = $c.FormatConditions.Add(2, 0, "=`$X`$$($t + 1)=`$X`$$($t + 2)"); $green.Interior.Color = 5287936
}
try {
  $wb = $xl.Workbooks.Open($In)
  $xl.Calculation = -4135
  foreach ($m in $Months) {
    $ws = $wb.Worksheets.Item($m)
    $ep = Find-Label $ws 'Estimated profit'; $sub = Find-Label $ws 'Subby days onsite'; $cli = Find-Label $ws 'Client days'
    if (-not $ep -or -not $sub -or $cli -ne $sub + 1) { "$m : layout not as expected (Estimated profit $ep, Subby $sub, Client $cli), skipped"; continue }
    if ((Find-Label $ws 'Test (estimate)')) { "$m : already done"; continue }
    $last = $ws.UsedRange.Row + $ws.UsedRange.Rows.Count
    $t1 = $ep + 2                      # Test (actual)
    $t2 = $t1 + 4                      # Test (estimate)
    # make room: everything from Subby days down moves so its first row lands at t1 + 1 ... then the rest goes below t2's block
    $need = ($t2 + 1) - $sub           # rows to move down so the old gap row (sub + 2) lands just under the estimate test
    $ws.Range("W$($sub):Z$($sub + $need - 1)").Insert(-4121) | Out-Null    # shift W:Z down
    $oldSub = $sub + $need
    # actual: bring Subby / Client back up under Test (cut keeps their formulas and anything pointing at them)
    $ws.Range("W$($oldSub):Z$($oldSub + 1)").Cut($ws.Range("W$($t1 + 1)")) | Out-Null
    # anything else that was between (the old blank row) stays as the gap above the VAT lines
    $ws.Range("W$t1").Value2 = 'Test'
    $ws.Range("X$($t1 + 1)").Formula = "=(COUNT(`$N`$1:`$R`$$last)-SUMPRODUCT((`$M`$1:`$M`$$last=`"$OC`")*ISNUMBER(`$N`$1:`$N`$$last)))/2"
    Set-Test $ws $t1
    # estimate (grey side), the same shape
    $ws.Range("W$($t1 + 1):Z$($t1 + 2)").Copy($ws.Range("W$($t2 + 1)")) | Out-Null
    $ws.Range("W$t2").Value2 = 'Test (estimate)'
    $ws.Range("W$($t2 + 1)").Value2 = 'Estimated subby days (grey side)'
    $ws.Range("X$($t2 + 1)").Formula = "=(COUNT(`$D`$1:`$H`$$last)-SUMPRODUCT((`$C`$1:`$C`$$last=`"$OC`")*ISNUMBER(`$D`$1:`$D`$$last)))/2"
    $ws.Range("W$($t2 + 2)").Value2 = 'Estimated client days (grey side)'
    $ws.Range("X$($t2 + 2)").Formula2 = '=SUMPRODUCT(IFERROR(COUNTIF($C$1:$G$5000,$W$4:$W$498)/2,0)*ISNUMBER($Y$4:$Y$498))'
    Set-Test $ws $t2
    "$m : Test at W$t1 (actual) and W$t2 (estimate)"
  }
  $xl.Calculation = -4105
  $xl.CalculateFull()
  $wb.Worksheets.Item($Months[0]).Activate(); $wb.Worksheets.Item($Months[0]).Range('A1').Select() | Out-Null
  $wb.SaveAs($Out, 51)
  $wb.Close($false)
  "saved $Out"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
