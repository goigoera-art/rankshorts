# Offline test of TikTok link parsing (no network). Run: powershell -NoProfile -File tests\tiktok-urls.ps1
. (Join-Path $PSScriptRoot '..\tiktok.ps1')
$cases = @(
  @('https://www.tiktok.com/@scout2015/video/6718335390845095173', 'id', '6718335390845095173'),
  @('https://tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1&sender_device=pc&web_id=7638362268632073749', 'id', '6718335390845095173'),
  @('https://m.tiktok.com/@scout2015/video/6718335390845095173', 'id', '6718335390845095173'),
  @('https://www.tiktok.com/@user.name_1/video/6718335390845095173/', 'id', '6718335390845095173'),
  @('https://www.tiktok.com/@%D1%8E%D0%B7%D0%B5%D1%80/video/6718335390845095173', 'id', '6718335390845095173'),
  @('https://www.tiktok.com/v/6718335390845095173.html', 'id', '6718335390845095173'),
  @('https://m.tiktok.com/v/6718335390845095173.html', 'id', '6718335390845095173'),
  @('https://www.tiktok.com/embed/v2/6718335390845095173', 'id', '6718335390845095173'),
  @('https://www.tiktok.com/player/v1/6718335390845095173?controls=1', 'id', '6718335390845095173'),
  @('https://www.tiktok.com/share/video/6718335390845095173', 'id', '6718335390845095173'),
  @('https://www.tiktok.com/some/path?item_id=6718335390845095173', 'id', '6718335390845095173'),
  @('https://vm.tiktok.com/ZMabc123/', 'short', $null),
  @('https://vt.tiktok.com/ZSabc123/', 'short', $null),
  @('https://www.tiktok.com/t/ZTabc123/', 'short', $null),
  @('https://www.tiktok.com/@scout2015/photo/6718335390845095173', 'photo', '6718335390845095173'),
  @('https://www.tiktok.com/@scout2015', 'bad', $null),
  @('https://www.tiktok.com/', 'bad', $null),
  @('https://evil-tiktok.com/@a/video/6718335390845095173', 'bad', $null),
  @('https://tiktok.com.evil.example/@a/video/6718335390845095173', 'bad', $null),
  @('https://www.youtube.com/watch?v=abc', 'bad', $null),
  @('not a url', 'bad', $null)
)
$fail = 0
foreach ($c in $cases) {
  $r = Get-TikTokUrlInfo $c[0]; $kind = 'bad'
  if ($r.ok -and $r.short) { $kind = 'short' } elseif ($r.ok -and $r.photo) { $kind = 'photo' } elseif ($r.ok) { $kind = 'id' }
  $okId = ($c[2] -eq $null) -or ($r.id -eq $c[2])
  $pass = ($kind -eq $c[1]) -and $okId
  if (-not $pass) { $fail++ }
  "{0} {1,-6} -> {2,-6} {3}" -f $(if ($pass) { 'PASS' } else { 'FAIL' }), $c[1], $kind, $c[0]
}
$res = Resolve-TikTokUrl 'https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1&web_id=1'
"resolved canonical: $($res.url)  (no network used: $($res.ok))"
if ($res.url -ne 'https://www.tiktok.com/@scout2015/video/6718335390845095173') { $fail++; 'FAIL canonical url' }
"photo -> $((Resolve-TikTokUrl 'https://www.tiktok.com/@a/photo/6718335390845095173').error)"
"failures: $fail"
exit $fail
