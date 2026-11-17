# After scripts/build-diary-year.mjs, in Excel on the office PC (Ronan, 15 Nov 2026):
#  - clerks in alphabetical order by first name (Ronan's own block stays at the top, the two spare "Others" blocks
#    at the bottom), moved by Excel itself so each block keeps its formulas, colours and merged name cell
#  - a block for each new clerk (a copy of an ordinary clerk's block), added to the Total Subcontractors sums
#  - estimated profit from the grey (planned) side, beside the actual profit
# Usage: powershell -File scripts/arrange-diary-clerks.ps1 -In "Diary 2027 built.xlsx" -Out "Diary 2027.xlsx" -NewClerks 'Ben Lacey','Paul Hankin'
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out, [string[]]$NewClerks = @(), [string[]]$Only = @())
$ErrorActionPreference = 'Stop'
$Months = @('January','February','March','April','May','June','July','August','September','October','November','December')
if ($Only.Count) { $Months = @($Months | Where-Object { $Only -contains $_ }) }  # e.g. -Only November,December (Diary 2026, 17 Nov 2026)
$H = 36  # rows per clerk: the header row, 31 days, sum, VAT, total, blank
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
try {
  $wb = $xl.Workbooks.Open($In)
  $xl.Calculation = -4135  # manual while moving things
  foreach ($m in $Months) {
    $ws = $wb.Worksheets.Item($m)
    function Names { $n = @(); $i = 0; while ($true) { $v = [string]$ws.Cells(3 + $H * $i, 1).Value2; if (-not $v.Trim()) { break }; $n += ($v -split "`n")[0].Trim(); $i++ }; return ,$n }
    function Top([int]$i) { return 2 + $H * $i }
    $names = Names
    # every block where it should be, 36 rows apart
    if ($names.Count -lt 40 -or $names[0] -ne 'Ronan' -or $names[-2] -ne 'Others 1' -or $names[-1] -ne 'Others 2') { throw "$m : unexpected blocks: $($names -join ', ')" }
    # new clerks: a copy of an ordinary clerk's block (the second one) put in before "Others 1"
    $added = @()
    foreach ($c in $NewClerks) {
      if ($names -contains $c) { continue }
      $o = [array]::IndexOf($names, 'Others 1')
      $ws.Range("A$(Top 1):T$((Top 1) + $H - 1)").Copy() | Out-Null
      $ws.Range("A$(Top $o):T$((Top $o) + $H - 1)").Insert(-4121) | Out-Null
      $s = (Top $o) + 1
      $ws.Cells($s, 1).Value2 = $c; $ws.Cells($s, 11).Value2 = $c
      # the copied block's typed-in entries (sites and comments, both sides) are the other clerk's: cleared
      foreach ($col in @('C','E','G','I','M','O','Q','S')) { $ws.Range("$col$($s):$col$($s + 30)").ClearContents() | Out-Null }
      $added += $c
      $names = Names
    }
    # alphabetical by first name between Ronan and the two Others
    $middle = $names[1..($names.Count - 3)] | Sort-Object { $_.ToLowerInvariant() }
    $want = @('Ronan') + $middle + @('Others 1', 'Others 2')
    for ($i = 1; $i -lt $want.Count - 2; $i++) {
      $names = Names
      $j = [array]::IndexOf($names, $want[$i])
      if ($j -eq $i) { continue }
      $ws.Range("A$(Top $j):T$((Top $j) + $H - 1)").Cut() | Out-Null
      $ws.Range("A$(Top $i):T$(Top $i)").EntireRow.Cells(1,1).Resize(1,20).Insert(-4121) | Out-Null
    }
    $names = Names
    if (($names -join '|') -ne ($want -join '|')) { throw "$m : order didn't come out right: $($names -join ', ')" }
    # the new clerks' costs in the profit totals (Total Subcontractors, and incl VAT)
    foreach ($c in $added) {
      $s = (Top ([array]::IndexOf($names, $c))) + 1
      $ws.Range('X501').Formula = $ws.Range('X501').Formula.TrimEnd(')') + ",S$($s + 31))"
      $ws.Range('X510').Formula = $ws.Range('X510').Formula.TrimEnd(')') + ",S$($s + 33))"
    }
    # estimated profit from the grey (planned) side, beside the actual profit
    $ws.Range('W500:Y502').Copy() | Out-Null; $ws.Range('W504:Y506').PasteSpecial(-4122) | Out-Null
    $ws.Range('W504').Value2 = 'Estimated charged (grey side)'
    $ws.Range('X504').Formula2 = '=SUMPRODUCT(IFERROR(COUNTIF($C$1:$G$5000,$W$4:$W$498)/2*$Y$4:$Y$498,0))'
    $ws.Range('W505').Value2 = 'Estimated subcontractors (grey side)'
    $ws.Range('X505').Formula = '=SUM(D39:D5000,F39:F5000,H39:H5000)'
    $ws.Range('W506').Value2 = 'Estimated profit'
    $ws.Range('X506').Formula = '=X504-X505'
    $ws.Range('Y506').Formula = '=IFERROR(X506/X504,"")'
    "$m : $($names.Count) blocks, added $($added -join ', ')"
  }
  $xl.Calculation = -4105
  $xl.CalculateFull()
  $wb.Worksheets.Item($Months[0]).Activate(); $wb.Worksheets.Item($Months[0]).Range('A1').Select() | Out-Null
  $wb.SaveAs($Out, 51)
  $wb.Close($false)
  "saved $Out"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
