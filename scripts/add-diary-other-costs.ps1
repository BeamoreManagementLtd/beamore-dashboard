# Adds an "Other costs" line to every clerk's block in a diary, on both sides (Ronan, 15 Nov 2026: "for each person's
# block, maybe have a line underneath that before we do the totals to say other costs... a comment and whatever costs,
# so that those costs are all added up and then match their invoices when we're checking").
#  - one new row between the last day and the totals: "Other costs (what for:)" in the 1st location column, what
#    they're for typed in the 2nd location column, the amount (net of VAT) in the 3rd slot's Cost column
#  - the block's sum takes it in, so VAT, the total and Total Subcontractors (and the grey side's estimate) include it
#  - rows are inserted by Excel in columns A:T only, so the client invoice tables beside the blocks don't move and
#    every reference adjusts itself
# The dashboard ignores this row as a visit (it's after day 31) and fills it from the expenses on a clerk's invoice.
# Usage: powershell -File scripts/add-diary-other-costs.ps1 -In "Diary 2027 v2.xlsx" -Out "Diary 2027 v3.xlsx"
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
$Months = @('January','February','March','April','May','June','July','August','September','October','November','December')
$Label = 'Other costs (what for:)'
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
try {
  $wb = $xl.Workbooks.Open($In)
  $xl.Calculation = -4135
  foreach ($m in $Months) {
    $ws = $wb.Worksheets.Item($m)
    # block starts: the clerk's name in column A, 36 rows apart (as built)
    $starts = @(); $i = 0
    while ($true) { $s = 3 + 36 * $i; if (-not ([string]$ws.Cells($s, 1).Value2).Trim()) { break }; $starts += $s; $i++ }
    if ($starts.Count -lt 40) { throw "$m : only $($starts.Count) blocks found" }
    if (([string]$ws.Cells($starts[0] + 31, 3).Value2) -eq $Label) { "$m : already has Other costs lines"; continue }
    # bottom block first, so the rows above don't move while we work
    for ($k = $starts.Count - 1; $k -ge 0; $k--) {
      $s = $starts[$k]; $r = $s + 31   # the row after day 31: the block's sum row today
      $fI = $ws.Range("I$r").Formula; $fS = $ws.Range("S$r").Formula
      $wantI = "=SUM(D$($s):D$($s + 30),F$($s):F$($s + 30),H$($s):H$($s + 30))"; $wantS = "=SUM(N$($s):N$($s + 30),P$($s):P$($s + 30),R$($s):R$($s + 30))"
      if ($fI -ne $wantI -or $fS -ne $wantS) { throw "$m block at row $s : sums aren't as expected ($fI / $fS)" }
      $ws.Range("A$($r):T$($r)").Insert(-4121, 0) | Out-Null   # shift down, formats from the row above (day 31)
      foreach ($c in @('C','M')) { $ws.Range("$c$r").Value2 = $Label; $ws.Range("$c$r").Font.Italic = $true }
      foreach ($c in @('E','F','G','H','I','O','P','Q','R','S')) { $ws.Range("$c$r").ClearContents() | Out-Null }
      $ws.Range("I$($r + 1)").Formula = "=SUM(D$($s):D$($s + 30),F$($s):F$($s + 30),H$($s):H$($s + 31))"
      $ws.Range("S$($r + 1)").Formula = "=SUM(N$($s):N$($s + 30),P$($s):P$($s + 30),R$($s):R$($s + 31))"
    }
    "$m : Other costs line added to $($starts.Count) blocks"
  }
  $xl.Calculation = -4105
  $xl.CalculateFull()
  $wb.Worksheets.Item('January').Activate(); $wb.Worksheets.Item('January').Range('A1').Select() | Out-Null
  $wb.SaveAs($Out, 51)
  $wb.Close($false)
  "saved $Out"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
