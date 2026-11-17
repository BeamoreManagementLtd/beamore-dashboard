# November 2026 grey-side (estimate) corrections (Ronan, 17 Nov 2026):
#  - October holidays left a blank week in November: filled with the clerk's usual week (Nick Jenkin, Gareth Mayoh, Carl Smith)
#  - holiday cover copied from October taken off the cover (Andy Kay's Highams Park / Siemens days for Nick Jenkin)
#  - Newman Street moves from Keith Osorio to Aidan Cusack (Aidan's free Wednesdays and Fridays); Keith's Holiday Inn days off
#    (Ronan replaced Holiday Inn's client-table row with Pepys Court on 17 Nov)
#  - extra end-of-October days (snagging etc.) trimmed to the usual week: Mark Prickett, Peter Lord, Conor Crossinggum, Tony Larkins
#  - new clerks: Stephen Brewer (as October: Harris Science Wed + Fri, Hadlow H&V Thu), Ben Lacey (Longfield, Mondays),
#    Alan Wilcox (Sandbach 2 days a week from 9 Nov); Chris Parry's Aylestone to 1 day a week (cost schedule: 4)
# Each entry: clerk, day of the month, the three places (C, E, G; '' clears a slot). Only the grey side is touched.
# Usage: & .\scripts\diary-nov-estimate-fixes.ps1 -In <diary.xlsx> -Out <diary.xlsx>
param([Parameter(Mandatory)][string]$In, [Parameter(Mandatory)][string]$Out)
$ErrorActionPreference = 'Stop'
$E = ''
$plan = @(
  # holiday gaps filled with the usual week
  @('Nick Jenkin', 23, 'Siemens', 'Siemens', 'HighamPark'), @('Nick Jenkin', 24, 'HighamPark', $E, $E),
  @('Nick Jenkin', 26, 'Siemens', 'Siemens', 'HighamPark'), @('Nick Jenkin', 27, 'HighamPark', $E, $E),
  @('Gareth Mayoh', 24, 'BlackburnCollege(M&E)', 'BlackburnCollege(M&E)', 'CastleHill(M&E)'), @('Gareth Mayoh', 26, 'CastleHill(M&E)', $E, $E),
  @('Carl Smith', 25, 'LincolnCastle(M&E)', 'LincolnCastle(M&E)', $E), @('Carl Smith', 30, 'Somerlea(M&E)', 'Somerlea(M&E)', $E),
  # Andy Kay's cover for Nick off
  @('Andy Kay', 9, $E, $E, $E), @('Andy Kay', 11, $E, $E, $E), @('Andy Kay', 13, 'CandyWharf', 'CandyWharf', $E),
  @('Andy Kay', 23, $E, $E, $E), @('Andy Kay', 25, $E, $E, $E), @('Andy Kay', 27, 'CandyWharf', 'CandyWharf', $E),
  # Newman Street: Keith Osorio -> Aidan Cusack
  @('Keith Osorio', 4, $E, $E, $E), @('Keith Osorio', 6, 'MonksWalk', 'MonksWalk', $E),
  @('Keith Osorio', 10, $E, $E, $E), @('Keith Osorio', 12, 'MonksWalk', 'MonksWalk', $E),
  @('Keith Osorio', 18, $E, $E, $E), @('Keith Osorio', 20, 'Gosford(Building)', 'Gosford(Building)', $E),
  @('Keith Osorio', 25, $E, $E, $E), @('Keith Osorio', 27, 'StMarks', 'StMarks', $E),
  @('Aidan Cusack', 4, 'NewmanSt', $E, $E), @('Aidan Cusack', 6, 'NewmanSt', $E, $E), @('Aidan Cusack', 11, 'NewmanSt', $E, $E), @('Aidan Cusack', 13, 'NewmanSt', $E, $E),
  @('Aidan Cusack', 18, 'NewmanSt', $E, $E), @('Aidan Cusack', 20, 'NewmanSt', $E, $E), @('Aidan Cusack', 25, 'NewmanSt', $E, $E), @('Aidan Cusack', 27, 'NewmanSt', $E, $E),
  # extra days trimmed to the usual week
  @('Mark Prickett', 23, 'StAidans(M&E)', 'StAidans(M&E)', 'Northumberland(M&E)'), @('Mark Prickett', 24, $E, $E, $E),
  @('Mark Prickett', 25, 'Northumberland(M&E)', 'Northumberland(M&E)', $E), @('Mark Prickett', 26, $E, $E, $E),
  @('Mark Prickett', 27, 'Greenfield(M&E)', 'Greenfield(M&E)', 'Northumberland(M&E)'),
  @('Peter Lord', 16, 'Connaught(M&E)', 'Connaught(M&E)', 'BurnsidePRU(M&E)'), @('Peter Lord', 17, $E, $E, $E),
  @('Peter Lord', 18, 'Connaught(M&E)', 'Connaught(M&E)', $E), @('Peter Lord', 19, $E, $E, $E),
  @('Peter Lord', 20, 'KingEthelbert(M&E)', 'KingEthelbert(M&E)', 'BurnsidePRU(M&E)'),
  @('Peter Lord', 23, 'KingEthelbert(M&E)', 'KingEthelbert(M&E)', $E), @('Peter Lord', 24, 'Connaught(M&E)', 'Connaught(M&E)', 'KingsMaths(M&E)'),
  @('Peter Lord', 25, $E, $E, $E), @('Peter Lord', 26, 'Connaught(M&E)', 'Connaught(M&E)', $E),
  @('Peter Lord', 27, 'BurnsidePRU(M&E)', 'BurnsidePRU(M&E)', 'KingsMaths(M&E)'),
  @('Conor Crossinggum', 23, 'OrmistonBridge', 'OrmistonBridge', 'Connaught'), @('Conor Crossinggum', 24, $E, $E, $E),
  @('Conor Crossinggum', 25, 'Connaught', $E, $E), @('Conor Crossinggum', 26, 'OrmistonBridge', 'OrmistonBridge', 'Connaught'),
  @('Conor Crossinggum', 27, 'Connaught', $E, $E),
  @('Tony Larkins', 23, 'HewittAcademy', 'HewittAcademy', 'Yarmouth'), @('Tony Larkins', 24, 'Yarmouth', 'Dukes', $E),
  @('Tony Larkins', 25, $E, $E, $E), @('Tony Larkins', 26, 'HewittAcademy', 'HewittAcademy', 'Yarmouth'),
  @('Tony Larkins', 27, 'Yarmouth', 'Dukes', $E),
  # new clerks / changed bookings
  @('Chris Parry', 5, $E, $E, $E), @('Chris Parry', 19, $E, $E, $E)
)
foreach ($d in 4, 11, 18, 25) { $plan += , @('Stephen Brewer', $d, 'HarrisScience', 'HarrisScience', $E) }
foreach ($d in 5, 12, 19, 26) { $plan += , @('Stephen Brewer', $d, 'HadlowH&V', 'HadlowH&V', $E) }
foreach ($d in 6, 13, 20, 27) { $plan += , @('Stephen Brewer', $d, 'HarrisScience', 'HarrisScience', $E) }
# Ben Lacey: Pepys Court on Mondays (Ronan put those in), Longfield on Thursdays
foreach ($d in 5, 12, 19, 26) { $plan += , @('Ben Lacey', $d, 'Longfield', 'Longfield', $E) }
# Paul Hankin: one day a week each at St Columba's (Mondays) and St John Vianney (Tuesdays)
foreach ($d in 2, 9, 16, 23) { $plan += , @('Paul Hankin', $d, 'StColumbas', 'StColumbas', $E) }
foreach ($d in 3, 10, 17, 24) { $plan += , @('Paul Hankin', $d, 'StJohnVianney', 'StJohnVianney', $E) }
# (Alan Wilcox: Ronan put in Sandbach Mon/Wed and Bramhall Tue/Thu himself)
# new sites: Rates (charge, clerk's rate) and a row each in the Gleeds client table (November and December)
$newRates = @(@('StColumbas', 450, 300), @('StColumbas(M&E)', 475, 350), @('StJohnVianney', 450, 300), @('StJohnVianney(M&E)', 475, 350))
$newClientRows = @{ Table = 'Gleeds'; Names = @('StColumbas', 'StJohnVianney') }

$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false; $xl.DisplayAlerts = $false; $xl.ScreenUpdating = $false
try {
  $wb = $xl.Workbooks.Open($In)
  $xl.Calculation = -4135
  # Rates: the new sites after the last one (inside the A1:C1146 the lookups use)
  $rs = $wb.Worksheets.Item('Rates'); $rv = $rs.Range('A1:A1146').Value2; $last = 0
  $known = @{}
  for ($i = 1; $i -le 1146; $i++) { if ($rv[$i, 1] -ne $null) { $last = $i; $known[([string]$rv[$i, 1]).ToLower()] = $true } }
  foreach ($x in $newRates) {
    if ($known.ContainsKey($x[0].ToLower())) { continue }   # already there
    $last++; $rs.Range("A$last").Value2 = $x[0]; $rs.Range("B$last").Value2 = [double]$x[1]; $rs.Range("C$last").Value2 = [double]$x[2]
    $rs.Range("A$($last - 1):C$($last - 1)").Copy() | Out-Null; $rs.Range("A$($last):C$last").PasteSpecial(-4122) | Out-Null
  }
  "Rates: up to row $last"
  # the Gleeds client table: two rows inserted above its last site, so the table's Gross takes them in
  foreach ($m in 'November', 'December') {
    $w = $wb.Worksheets.Item($m); $wv = $w.Range('W1:Y498').Value2
    $head = 0; for ($i = 1; $i -le 498; $i++) { if ([string]$wv[$i, 1] -eq $newClientRows.Table -and [string]$wv[$i, 2] -eq 'No of days') { $head = $i; break } }
    if (-not $head) { throw "$m : no $($newClientRows.Table) client table" }
    $gross = 0; for ($i = $head + 1; $i -le 498; $i++) { if ([string]$wv[$i, 3] -eq 'Gross') { $gross = $i; break } }
    $have = @(); for ($i = $head + 1; $i -lt $gross; $i++) { $have += [string]$wv[$i, 1] }
    $add = @($newClientRows.Names | Where-Object { $have -notcontains $_ })
    if (-not $add.Count) { "$m : client rows already there"; continue }
    $at = $gross - 1
    $w.Range("W$($at):AA$($at + $add.Count - 1)").Insert(-4121) | Out-Null    # shift W:AA down, formulas below follow
    for ($k = 0; $k -lt $add.Count; $k++) {
      $r = $at + $k
      $w.Range("W$($at + $add.Count):AA$($at + $add.Count)").Copy($w.Range("W$($r):AA$r")) | Out-Null
      $w.Range("W$r").Value2 = $add[$k]
      $w.Range("X$r").Formula = "=COUNTIF(M:Q,W$r)/2"
      $w.Range("Y$r").Formula = "=VLOOKUP(W$r,Rates!`$A`$1:`$C`$1146,2,FALSE)"
      $w.Range("Z$r").Formula = "=X$r*Y$r"
      $w.Range("AA$r").ClearContents() | Out-Null
    }
    "$m : $($add -join ', ') added to the $($newClientRows.Table) table at W$at (Gross now " + $w.Range("Z$($gross + $add.Count)").Formula + ")"
  }
  $ws = $wb.Worksheets.Item('November')
  $v = $ws.Range('A1:C2100').Value2
  # each clerk's day rows: from the name row to the block's Other costs line
  $days = @{}
  for ($r = 1; $r -le 2100; $r++) {
    $a = $v[$r, 1]; if (-not ($a -is [string]) -or -not $a.Trim()) { continue }
    $who = ($a -split "`n")[0].Trim(); if ($days.ContainsKey($who)) { continue }
    $map = @{}
    for ($k = $r; $k -le $r + 40; $k++) {
      if ([string]$v[$k, 3] -eq 'Other costs (what for:)') { break }
      if ($v[$k, 2] -is [double]) { $map[[DateTime]::FromOADate($v[$k, 2]).Day] = $k }
    }
    $days[$who] = $map
  }
  $n = 0
  foreach ($p in $plan) {
    $who, $day, $c, $e, $g = $p
    if (-not $days.ContainsKey($who)) { throw "no block for $who" }
    $r = $days[$who][$day]; if (-not $r) { throw "$who has no row for $day November" }
    foreach ($pair in @(@('C', $c), @('E', $e), @('G', $g))) {
      $cell = $ws.Range("$($pair[0])$r")
      if ($pair[1] -eq '') { $cell.ClearContents() | Out-Null } else { $cell.Value2 = $pair[1] }
    }
    $n++
  }
  "November: $n days set"
  $xl.Calculation = -4105
  $xl.CalculateFull()
  $wb.Worksheets.Item('November').Activate(); $ws.Range('A1').Select() | Out-Null
  $wb.SaveAs($Out, 51)
  $wb.Close($false)
  "saved $Out"
} finally { $xl.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($xl) }
