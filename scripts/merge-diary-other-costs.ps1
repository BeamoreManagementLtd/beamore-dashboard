# "Other costs" lines, final layout (Ronan, 17 Nov 2026: "get rid of the vertical borders ... make it one box and maybe
# merge it so that when people write, it's just one bit of writing"):
#   C "Other costs (what for:)" | D the amount | E:H merged, what it's for | I (comments, as before)
#   M ... | N the amount | O:R merged | S        (salmon side the same)
#  - an amount already typed in H / R moves to D / N; a description in E / O stays (it's the merged cell's text)
#  - the block's sum takes the amount from D / N on this line (day rows unchanged)
#  - the line keeps its thick box; thin lines only between label, amount, description and comments
# Usage: & .\scripts\merge-diary-other-costs.ps1 -In <diary.xlsx> -Out <diary.xlsx> [-Only 'November','December']
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
    $done = 0; $movedAmounts = 0
    for ($r = 3; $r -le $last; $r++) {
      if (([string]$ws.Range("C$r").Value2) -ne $Label) { continue }
      # the block's first day row: the sum row (r + 1) adds up D/F/H from there
      foreach ($side in @(@{ lbl = 'C'; amt = 'D'; from = 'E'; to = 'H'; com = 'I'; f2 = 'F' }, @{ lbl = 'M'; amt = 'N'; from = 'O'; to = 'R'; com = 'S'; f2 = 'P' })) {
        $amt = $ws.Range("$($side.amt)$r"); $old = $ws.Range("$($side.to)$r")
        # the amount: next to the label (moved from the 3rd slot's cost cell if it was typed there)
        $was = $old.Value2
        if ($amt.HasFormula) { $amt.ClearContents() | Out-Null }
        if ($was -ne $null -and "$was".Trim() -ne '' -and ($amt.Value2 -eq $null -or "$($amt.Value2)".Trim() -eq '')) { $amt.Value2 = $was; $movedAmounts++ }
        $old.ClearContents() | Out-Null
        $amt.NumberFormat = $ws.Range("$($side.amt)$($r - 1)").NumberFormat
        # one box for what it's for
        $desc = $ws.Range("$($side.from)$($r):$($side.to)$r")
        if (-not $desc.MergeCells) { $text = $ws.Range("$($side.from)$r").Value2; $desc.Merge() | Out-Null; $ws.Range("$($side.from)$r").Value2 = $text }
        $desc.HorizontalAlignment = -4131; $desc.WrapText = $false
        # lines: thick outside, thin between label | amount | description | comments
        $box = $ws.Range("$($side.lbl)$($r):$($side.com)$r").Borders
        foreach ($e in 7, 8, 9, 10) { $box.Item($e).LineStyle = 1; $box.Item($e).Weight = -4138 }
        foreach ($c in $side.amt, $side.from, $side.com) { $b = $ws.Range("$c$r").Borders.Item(7); $b.LineStyle = 1; $b.Weight = 2 }
        # the block's sum: the amount from this line's amount cell
        $sum = $ws.Range("$($side.com)$($r + 1)")
        $f = [string]$sum.Formula
        $mm = [regex]::Match($f, '^=SUM\(' + $side.amt + '(\d+):' + $side.amt + '(\d+),' + $side.f2 + '\d+:' + $side.f2 + '\d+,' + $side.to + '(\d+):' + $side.to + '(\d+)\)$')
        if ($mm.Success) {
          $s = [int]$mm.Groups[1].Value
          $sum.Formula = "=SUM($($side.amt)$($s):$($side.amt)$r,$($side.f2)$($s):$($side.f2)$($r - 1),$($side.to)$($s):$($side.to)$($r - 1))"
        } elseif ($f -notmatch "$($side.amt)\d+:$($side.amt)$r") { throw "$m row $r : block sum not as expected: $f" }
      }
      $done++
    }
    "$m : $done Other costs lines merged ($movedAmounts amounts moved next to the label)"
  }
  $xl.Calculation = -4105
  $xl.CalculateFull()
  $wb.Worksheets.Item($Months[0]).Activate(); $wb.Worksheets.Item($Months[0]).Range('A1').Select() | Out-Null
  $wb.SaveAs($Out, 51)
  $wb.Close($false)
  "saved $Out"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
