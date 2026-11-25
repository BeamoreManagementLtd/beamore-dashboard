# Splits each clerk's "Other costs" line into two (Ronan, 25 Nov 2026: "should we have 2 lines, costs which are
# reclaimable from the client and costs which aren't"), and moves the amount to the end of the line ("the cost ... should
# be in column S, not in column N ... so they can type what the expense is for in N, O, P, Q and R, and then the cost of it
# goes in S"):
#   M "Recharge to client" | N:R merged, what it's for | S the amount
#   M "Not recharged"      | N:R merged, what it's for | S the amount
#   (grey side the same: C | D:H | I)
#  - the block's sum (S / I, under the two lines) adds the day costs plus both amounts, so it still matches the invoice
#  - anything already on the old line goes on the "not recharged" line (amount to S / I, comment kept with what it's for)
#  - rows are inserted by Excel in columns A:T only, so the client tables beside the blocks don't move
#  - month totals: Subby days onsite / Estimated subby days count day slots only (the amounts aren't in N:R / D:H any more),
#    the grey-side subcontractor estimate adds the amounts, and two new lines: Costs to recharge to clients and
#    Profit incl. recharges
# Usage: & .\scripts\split-diary-other-costs.ps1 -In <diary.xlsx> -Out <diary.xlsx> [-Only 'November','December']
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out, [string[]]$Only = @())
$ErrorActionPreference = 'Stop'
$Months = @('January','February','March','April','May','June','July','August','September','October','November','December')
if ($Only.Count) { $Months = @($Months | Where-Object { $Only -contains $_ }) }
$Old = 'Other costs (what for:)'
$L1 = 'Recharge to client'
$L2 = 'Not recharged'
$Sides = @(@{ lbl = 'C'; from = 'D'; to = 'H'; amt = 'I'; f2 = 'F' }, @{ lbl = 'M'; from = 'N'; to = 'R'; amt = 'S'; f2 = 'P' })
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
function Find-W($ws, $text) { for ($r = 480; $r -le 600; $r++) { if (([string]$ws.Range("W$r").Value2).Trim() -eq $text) { return $r } }; return 0 }
function Blank($v) { return ($v -eq $null -or "$v".Trim() -eq '') }
try {
  $wb = $xl.Workbooks.Open($In)
  $xl.Calculation = -4135
  foreach ($m in $Months) {
    $ws = $wb.Worksheets.Item($m)
    $last = $ws.UsedRange.Row + $ws.UsedRange.Rows.Count
    $lines = @(); for ($r = 3; $r -le $last; $r++) { if (([string]$ws.Range("C$r").Value2) -eq $Old) { $lines += $r } }
    if (-not $lines.Count) { "$m : no Other costs lines (already split?), skipped"; continue }
    $carried = 0
    for ($k = $lines.Count - 1; $k -ge 0; $k--) {   # bottom first, so the rows above don't move while we work
      $r = $lines[$k]
      # what's on the old line now: label | amount (D/N) | what for (E/O, merged E:H) | comment (I/S)
      $was = @{}
      foreach ($sd in $Sides) {
        $amtCol = [char]([int][char]$sd.lbl + 1); $descCol = [char]([int][char]$sd.lbl + 2)
        $was[$sd.lbl] = @{ amt = $ws.Range("$amtCol$r").Value2; desc = $ws.Range("$descCol$r").Value2; com = $ws.Range("$($sd.amt)$r").Value2 }
        if ($ws.Range("$amtCol$r").HasFormula) { $was[$sd.lbl].amt = $null }
      }
      $ws.Range("A$($r + 1):T$($r + 1)").Insert(-4121, 0) | Out-Null   # shift down, formats from the old line
      foreach ($sd in $Sides) {
        $fmt = $ws.Range("$($sd.f2)$($r - 1)").NumberFormat   # a day row's cost cell
        foreach ($rr in @($r, ($r + 1))) {
          $line = $ws.Range("$($sd.lbl)$($rr):$($sd.amt)$rr")
          $line.UnMerge() | Out-Null
          $ws.Range("$($sd.from)$($rr):$($sd.amt)$rr").ClearContents() | Out-Null
          $lbl = $ws.Range("$($sd.lbl)$rr"); $lbl.Value2 = $(if ($rr -eq $r) { $L1 } else { $L2 }); $lbl.Font.Italic = $true; $lbl.WrapText = $false; $lbl.ShrinkToFit = $true
          $desc = $ws.Range("$($sd.from)$($rr):$($sd.to)$rr"); $desc.Merge() | Out-Null; $desc.HorizontalAlignment = -4131; $desc.WrapText = $false; $desc.Font.Italic = $false
          $amt = $ws.Range("$($sd.amt)$rr"); $amt.NumberFormat = $fmt; $amt.HorizontalAlignment = -4152; $amt.Font.Italic = $false
          $b = $line.Borders
          foreach ($e in 7, 8, 9, 10) { $b.Item($e).LineStyle = 1; $b.Item($e).Weight = -4138 }   # thick box, like the block
          foreach ($c in $sd.from, $sd.amt) { $x = $ws.Range("$c$rr").Borders.Item(7); $x.LineStyle = 1; $x.Weight = 2 }   # thin: label | what for | amount
        }
        $mid = $ws.Range("$($sd.lbl)$($r):$($sd.amt)$r").Borders.Item(9); $mid.LineStyle = 1; $mid.Weight = 2   # thin between the two lines
        # anything that was on the old line goes on "not recharged"
        $w = $was[$sd.lbl]
        $text = @(@($w.desc, $w.com) | Where-Object { -not (Blank $_) }) -join ' - '
        if ($text) { $ws.Range("$($sd.from)$($r + 1)").Value2 = $text; $carried++ }
        if (-not (Blank $w.amt)) { $ws.Range("$($sd.amt)$($r + 1)").Value2 = $w.amt; $carried++ }
        # the block's sum, now two rows under: day costs + both amounts
        $sum = $ws.Range("$($sd.amt)$($r + 2)")
        $f = [string]$sum.Formula
        $mm = [regex]::Match($f, '^=SUM\(' + $sd.from + '(\d+):' + $sd.from + '\d+,')
        if (-not $mm.Success) { throw "$m row $($r + 2) : block sum not as expected: $f" }
        $s = [int]$mm.Groups[1].Value
        $sum.Formula = "=SUM($($sd.from)$($s):$($sd.from)$($r - 1),$($sd.f2)$($s):$($sd.f2)$($r - 1),$($sd.to)$($s):$($sd.to)$($r - 1),$($sd.amt)$($r):$($sd.amt)$($r + 1))"
      }
      $ws.Rows($r + 1).RowHeight = $ws.Rows($r).RowHeight
    }
    # month totals
    $sub = Find-W $ws 'Subby days onsite'; if ($sub) { $ws.Range("X$sub").Formula = '=COUNT($N$1:$R$5000)/2' }
    $est = Find-W $ws 'Estimated subby days (grey side)'; if ($est) { $ws.Range("X$est").Formula = '=COUNT($D$1:$H$5000)/2' }
    $gs = Find-W $ws 'Estimated subcontractors (grey side)'
    if ($gs) { $ws.Range("X$gs").Formula = '=SUM(D39:D5000,F39:F5000,H39:H5000)+SUMIF($C$39:$C$5000,"Recharge to client",$I$39:$I$5000)+SUMIF($C$39:$C$5000,"Not recharged",$I$39:$I$5000)' }
    $vat = Find-W $ws 'VAT due to HMRC'; $tc = Find-W $ws 'Total Charged'; $ts = Find-W $ws 'Total Subcontractors'
    if ($vat -and $tc -and $ts -and -not (Find-W $ws 'Costs to recharge to clients')) {
      $a = $vat + 2
      if (-not (Blank $ws.Range("W$a").Value2) -or -not (Blank $ws.Range("W$($a + 1)").Value2) -or -not (Blank $ws.Range("X$a").Value2)) { "$m : no room under VAT due to HMRC for the recharge lines" }
      else {
        $ws.Range("W$a").Value2 = 'Costs to recharge to clients'
        $ws.Range("X$a").Formula = "=SUMIF(`$M`$1:`$M`$5000,`"$L1`",`$S`$1:`$S`$5000)"
        $ws.Range("W$($a + 1)").Value2 = 'Profit incl. recharges'
        $ws.Range("X$($a + 1)").Formula = "=X$tc+X$a-X$ts"
        $ws.Range("X$($a):X$($a + 1)").NumberFormat = $ws.Range("X$ts").NumberFormat
      }
    }
    "$m : $($lines.Count) Other costs lines split ($carried values carried over)"
  }
  $xl.Calculation = -4105
  $xl.CalculateFull()
  $wb.Worksheets.Item($Months[0]).Activate(); $wb.Worksheets.Item($Months[0]).Range('A1').Select() | Out-Null
  $wb.SaveAs($Out, 51)
  $wb.Close($false)
  "saved $Out"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
