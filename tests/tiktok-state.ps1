# Offline test of the block/cooldown state machine (no network). Run: powershell -NoProfile -File tests\tiktok-state.ps1
. (Join-Path $PSScriptRoot '..\tiktok.ps1')
$fail = 0
function Check($name, $cond) { if (-not $cond) { $script:fail++ }; "{0} {1}" -f $(if ($cond) { 'PASS' } else { 'FAIL' }), $name }
Check 'fresh state is not blocked (was an Int32 overflow)' ($null -eq (Test-TikBlockedNow))
$script:TikBlockedUntil = (Get-Date).AddSeconds(30)
$b = Test-TikBlockedNow
Check 'cooldown reports tiktok_blocked' ($b.error -eq 'tiktok_blocked' -and $b.retryable -eq $true)
Check 'cooldown reports seconds left (1..30)' ($b.retryAfter -ge 1 -and $b.retryAfter -le 30)
Check 'import is refused during cooldown without a request' ((Get-TikTokVideo @{ id = '1'; url = 'https://www.tiktok.com/@a/video/1' } $env:TEMP).error -eq 'tiktok_blocked')
Check 'short link resolution refused during cooldown' ((Resolve-TikTokUrl 'https://vm.tiktok.com/ZMabc/').error -eq 'tiktok_blocked')
$script:TikBlockedUntil = (Get-Date).AddSeconds(-1)
Check 'cooldown expires' ($null -eq (Test-TikBlockedNow))
Check 'WAF page detected' (Test-TikWafPage '<html><body>Please wait... <p class="_wafchallengeid"></p></body></html>')
Check 'normal page not flagged' (-not (Test-TikWafPage ('x' * 6000)))
$tmp = Join-Path $env:TEMP 'rs_test_video.bin'
[IO.File]::WriteAllBytes($tmp, [byte[]](0,0,0,0x18,0x66,0x74,0x79,0x70,0x6d,0x70,0x34,0x32,0,0))
Check 'mp4 magic accepted' (Test-VideoFile $tmp)
[IO.File]::WriteAllBytes($tmp, [Text.Encoding]::ASCII.GetBytes('<html><body>blocked page</body></html>'))
Check 'html rejected as video' (-not (Test-VideoFile $tmp))
Remove-Item $tmp -ErrorAction SilentlyContinue
"failures: $fail"; exit $fail
