# RankShorts: built-in TikTok downloader (used when yt-dlp is missing or fails).
# It only reads the public video page like a normal visitor. It does NOT solve or bypass TikTok's
# anti-bot check, and it never retries a blocked request by itself: when TikTok shows that check we
# stop, report it to the user, and only a manual "Повторить" (after the cooldown) sends a new request.
#
# Dot-sourced by serve.ps1. Functions return hashtables:
#   @{ ok=$true; ... }  or  @{ ok=$false; error='code'; details='text'; retryable=$bool; retryAfter=<sec> }

$script:TikUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
$script:TikSession = $null          # cookie jar kept between imports (a normal browser keeps cookies too)
$script:TikLastRequest = [datetime]::MinValue
$script:TikBlockedUntil = [datetime]::MinValue
$script:TikMinGapSec = 1.5          # pause between our requests to TikTok
$script:TikCooldownSec = 45         # after an anti-bot page we do not touch TikTok for this long

function New-TikSession {
  $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $s.UserAgent = $script:TikUA
  $script:TikSession = $s
}

function Wait-TikTurn {
  $gap = ((Get-Date) - $script:TikLastRequest).TotalSeconds
  if ($gap -lt $script:TikMinGapSec) { Start-Sleep -Milliseconds ([int](($script:TikMinGapSec - $gap) * 1000)) }
  $script:TikLastRequest = Get-Date
}

function New-TikError([string]$code, [string]$details = '', [bool]$retryable = $false, [int]$retryAfter = 0) {
  return @{ ok = $false; error = $code; details = $details; retryable = $retryable; retryAfter = $retryAfter }
}

function Test-TikBlockedNow {
  $now = Get-Date
  if ($script:TikBlockedUntil -le $now) { return $null }
  $left = [int][Math]::Ceiling(($script:TikBlockedUntil - $now).TotalSeconds)
  return (New-TikError 'tiktok_blocked' 'TikTok anti-bot check (cooldown, no request sent)' $true $left)
}

function Test-TikWafPage([string]$html) {
  return ($html.Contains('_wafchallengeid') -or ($html.Length -lt 5000 -and $html.Contains('Please wait')))
}

# Pure function (no network): what kind of TikTok link is this?
#   -> @{ ok; id; user; photo }   a link that already contains the video id
#   -> @{ ok; short=$true }       a short link that must be followed (vm./vt./tiktok.com/t/...)
#   -> @{ ok=$false; error }      not a TikTok video link
function Get-TikTokUrlInfo([string]$url) {
  $u = $null
  try { $u = [Uri]$url } catch { return @{ ok = $false; error = 'bad_url' } }
  if (-not $u.IsAbsoluteUri -or $u.Scheme -notin @('http', 'https') -or $u.Host -notmatch '(^|\.)tiktok\.com$') {
    return @{ ok = $false; error = 'tiktok_unsupported_url' }
  }
  $path = $u.AbsolutePath
  $m = [regex]::Match($path, '^/@([^/]+)/(video|photo)/(\d{6,})')
  if ($m.Success) {
    return @{ ok = $true; id = $m.Groups[3].Value; user = [Uri]::UnescapeDataString($m.Groups[1].Value); photo = ($m.Groups[2].Value -eq 'photo') }
  }
  foreach ($re in @('^/(?:share/)?video/(\d{6,})', '^/v/(\d{6,})', '^/embed(?:/v\d)?/(\d{6,})', '^/player/v\d/(\d{6,})')) {
    $m = [regex]::Match($path, $re)
    if ($m.Success) { return @{ ok = $true; id = $m.Groups[1].Value; user = '_'; photo = $false } }
  }
  $q = [regex]::Match($u.Query, '[?&](?:item_id|share_item_id|aweme_id)=(\d{6,})')
  if ($q.Success) { return @{ ok = $true; id = $q.Groups[1].Value; user = '_'; photo = $false } }
  if ($u.Host -match '^(vm|vt)\.tiktok\.com$' -or $path -match '^/t/[\w-]+') { return @{ ok = $true; short = $true } }
  return @{ ok = $false; error = 'tiktok_unsupported_url' }
}

# Any TikTok link -> canonical video (id, user, url). Short links are followed hop by hop; every hop
# must stay on tiktok.com. Tracking parameters (?is_from_webapp=..., web_id=...) are dropped.
function Resolve-TikTokUrl([string]$url) {
  $cur = $url
  for ($hop = 0; $hop -le 5; $hop++) {
    $i = Get-TikTokUrlInfo $cur
    if (-not $i.ok) { return (New-TikError $i.error "$cur") }
    if ($i.id) {
      if ($i.photo) { return (New-TikError 'tiktok_photo' $i.id) }
      return @{ ok = $true; id = $i.id; user = $i.user; url = "https://www.tiktok.com/@$($i.user)/video/$($i.id)" }
    }
    $blocked = Test-TikBlockedNow; if ($blocked) { return $blocked }
    Wait-TikTurn
    $resp = $null
    try {
      $wr = [Net.HttpWebRequest]::Create($cur)
      $wr.AllowAutoRedirect = $false; $wr.Timeout = 15000; $wr.UserAgent = $script:TikUA
      $resp = $wr.GetResponse()
    } catch [Net.WebException] {
      $resp = $_.Exception.Response
      if (-not $resp) { return (New-TikError 'tiktok_page_failed' "$($_.Exception.Message)" $true) }
    } catch { return (New-TikError 'tiktok_page_failed' "$($_.Exception.Message)" $true) }
    $code = [int]$resp.StatusCode; $loc = $resp.Headers['Location']; $resp.Close()
    if ($code -ge 300 -and $code -lt 400 -and $loc) {
      try { $cur = (New-Object Uri ([Uri]$cur), $loc).AbsoluteUri } catch { return (New-TikError 'tiktok_bad_redirect' "$loc") }
      continue
    }
    return (New-TikError 'tiktok_bad_redirect' "HTTP $code without redirect")
  }
  return (New-TikError 'tiktok_bad_redirect' 'too many redirects')
}

function Test-VideoFile([string]$path) {
  try {
    $fs = [IO.File]::OpenRead($path); $b = New-Object byte[] 12
    $n = $fs.Read($b, 0, 12); $fs.Close()
    if ($n -lt 12) { return $false }
    if ($b[4] -eq 0x66 -and $b[5] -eq 0x74 -and $b[6] -eq 0x79 -and $b[7] -eq 0x70) { return $true }   # "ftyp" (mp4/mov)
    if ($b[0] -eq 0x1A -and $b[1] -eq 0x45 -and $b[2] -eq 0xDF -and $b[3] -eq 0xA3) { return $true }  # EBML (webm)
  } catch { }
  return $false
}

# Downloads one video into $dir. $v is the result of Resolve-TikTokUrl.
function Get-TikTokVideo($v, [string]$dir) {
  $ProgressPreference = 'SilentlyContinue'
  $hdr = @{ 'Accept-Language' = 'en-US,en;q=0.9'; 'Accept' = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  $html = $null
  # Exactly one request per import. If TikTok answers with its anti-bot page ("Please wait") we stop
  # right there: no automatic retry, no challenge solving. The user can press "Повторить" later.
  $blocked = Test-TikBlockedNow; if ($blocked) { return $blocked }
  if (-not $script:TikSession) { New-TikSession }
  Wait-TikTurn
  try {
    $page = Invoke-WebRequest -Uri $v.url -WebSession $script:TikSession -UserAgent $script:TikUA -Headers $hdr -UseBasicParsing -TimeoutSec 25 -MaximumRedirection 5
  } catch {
    $sc = 0; try { $sc = [int]$_.Exception.Response.StatusCode } catch { }
    if ($sc -eq 404) { return (New-TikError 'tiktok_removed' 'HTTP 404') }
    return (New-TikError 'tiktok_page_failed' "$($_.Exception.Message)" $true)
  }
  $html = [string]$page.Content
  if (Test-TikWafPage $html) {
    New-TikSession   # drop the cookies of the blocked session
    $script:TikBlockedUntil = (Get-Date).AddSeconds($script:TikCooldownSec)
    return (New-TikError 'tiktok_blocked' 'TikTok returned its anti-bot check page ("Please wait")' $true $script:TikCooldownSec)
  }

  # Page data: JSON block first, plain text search as a fallback.
  $item = $null; $status = 0; $statusMsg = ''
  $jm = [regex]::Match($html, '<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)</script>', 'Singleline')
  if ($jm.Success) {
    try {
      $detail = ($jm.Groups[1].Value | ConvertFrom-Json).__DEFAULT_SCOPE__.'webapp.video-detail'
      if ($detail) { $status = [int]$detail.statusCode; $statusMsg = "$($detail.statusMsg)"; $item = $detail.itemInfo.itemStruct }
    } catch { }
  }
  if ($status -ne 0 -or ($jm.Success -and -not $item -and $statusMsg)) {
    if ($status -eq 10222 -or $statusMsg -match 'private') { return (New-TikError 'tiktok_private' "status $status $statusMsg") }
    if ($status -eq 10204 -or $statusMsg -match "not exist|doesn.t exist|removed|deleted|unavailable") { return (New-TikError 'tiktok_removed' "status $status $statusMsg") }
    return (New-TikError 'tiktok_no_video' "status $status $statusMsg")
  }
  $videoUrl = $null
  if ($item) {
    if ($item.id -and "$($item.id)" -ne $v.id) { return (New-TikError 'tiktok_no_video' "page belongs to another video ($($item.id))") }
    if ($item.imagePost) { return (New-TikError 'tiktok_photo' $v.id) }
    foreach ($c in @($item.video.playAddr, $item.video.downloadAddr)) { if ($c -and "$c" -match '^https?:') { $videoUrl = "$c"; break } }
  }
  if (-not $videoUrl) {
    $m = [regex]::Match($html, '"playAddr":"(https?:[^"]+)"')
    if (-not $m.Success) { $m = [regex]::Match($html, '"downloadAddr":"(https?:[^"]+)"') }
    if ($m.Success) { $videoUrl = [regex]::Unescape($m.Groups[1].Value) }
  }
  if (-not $videoUrl) { return (New-TikError 'tiktok_no_video' 'no video address on the page') }

  $out = Join-Path $dir ("tiktok-$($v.id).mp4")
  try {
    Wait-TikTurn
    Invoke-WebRequest -Uri $videoUrl -WebSession $script:TikSession -UserAgent $script:TikUA -Headers @{ 'Referer' = 'https://www.tiktok.com/' } -OutFile $out -UseBasicParsing -TimeoutSec 180 | Out-Null
  } catch {
    return (New-TikError 'tiktok_download_failed' "$($_.Exception.Message)" $true)
  }
  if (-not (Test-Path $out) -or (Get-Item $out).Length -lt 20000 -or -not (Test-VideoFile $out)) {
    return (New-TikError 'tiktok_download_failed' 'the downloaded file is not a video' $true)
  }
  return @{ ok = $true; file = $out; id = $v.id }
}
