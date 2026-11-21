# RankShorts local server: serves ./public and provides link import via yt-dlp.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 [-Port 8787] [-NoBrowser]
param([int]$Port = 8787, [switch]$NoBrowser)

$ErrorActionPreference = 'Continue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'tiktok.ps1')
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'public'))
$Mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'
  '.mp4' = 'video/mp4'; '.webm' = 'video/webm'; '.mov' = 'video/quicktime'; '.mkv' = 'video/x-matroska'; '.m4v' = 'video/mp4'
}

function Find-YtDlp {
  $local = Join-Path $PSScriptRoot 'tools\yt-dlp.exe'
  if (Test-Path $local) { return $local }
  $cmd = Get-Command yt-dlp -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Send-Bytes($res, [byte[]]$bytes, [string]$type, [int]$code = 200) {
  $res.StatusCode = $code
  $res.ContentType = $type
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-Json($res, $obj, [int]$code = 200) {
  $json = $obj | ConvertTo-Json -Compress -Depth 5
  Send-Bytes $res ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8' $code
}

function Send-File($res, [string]$path) {
  $ext = [IO.Path]::GetExtension($path).ToLower()
  $type = 'application/octet-stream'
  if ($Mime.ContainsKey($ext)) { $type = $Mime[$ext] }
  $fs = [IO.File]::OpenRead($path)
  try {
    $res.StatusCode = 200
    $res.ContentType = $type
    $res.ContentLength64 = $fs.Length
    $res.AddHeader('Cache-Control', 'no-cache')
    $fs.CopyTo($res.OutputStream)
  } finally { $fs.Close() }
}

function Send-ImportError($res, $r) {
  $body = @{ error = $r.error; details = "$($r.details)"; retryable = [bool]$r.retryable; retryAfter = [int]$r.retryAfter }
  Write-Host "Import failed: $($r.error) $($r.details)"
  Send-Json $res $body 502
}

function Invoke-Import($req, $res) {
  $target = $req.QueryString['url']
  if (-not $target -or $target.Length -gt 2000 -or $target -notmatch '^https?://[^\s"''<>`]+$') {
    Send-Json $res @{ error = 'bad_url' } 400; return
  }
  $isTikTok = $false
  try { $isTikTok = ([Uri]$target).Host -match '(^|\.)tiktok\.com$' } catch { }
  $yt = Find-YtDlp
  if (-not $yt -and -not $isTikTok) { Send-Json $res @{ error = 'no_ytdlp' } 501; return }

  $dir = Join-Path ([IO.Path]::GetTempPath()) ('rankshorts_' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $dir | Out-Null
  try {
    Write-Host "Import: $target"
    $filePath = $null; $method = ''; $fail = $null; $videoId = ''
    # TikTok: first turn any link (short, redirecting, with tracking parameters) into one canonical video.
    $tt = $null
    if ($isTikTok) {
      $tt = Resolve-TikTokUrl $target
      if (-not $tt.ok) { Send-ImportError $res $tt; return }
      $videoId = $tt.id
      $target = $tt.url
    }
    if ($yt) {
      $outTpl = Join-Path $dir 'video.%(ext)s'
      # Single-file formats only (no ffmpeg needed for merging).
      $log = & $yt --no-playlist --no-progress --no-warnings -f 'b[ext=mp4]/b' --max-filesize 500M -o $outTpl -- $target 2>&1 | Out-String
      $code = $LASTEXITCODE
      $file = Get-ChildItem -Path $dir -File | Where-Object { $_.Extension -notin @('.part', '.ytdl', '.temp') } | Select-Object -First 1
      if ($code -eq 0 -and $file) { $filePath = $file.FullName; $method = 'yt-dlp' }
      else {
        $tail = $log.Trim()
        if ($tail.Length -gt 700) { $tail = $tail.Substring($tail.Length - 700) }
        $fail = @{ error = 'download_failed'; details = $tail; retryable = $false }
        Get-ChildItem -Path $dir -File | Remove-Item -Force -ErrorAction SilentlyContinue
      }
    }
    if (-not $filePath -and $isTikTok) {
      $r = Get-TikTokVideo $tt $dir
      if ($r.ok) { $filePath = $r.file; $method = 'builtin' } else { $fail = $r }
    }
    if (-not $filePath) { Send-ImportError $res $fail; return }
    $name = [IO.Path]::GetFileName($filePath)
    if ($videoId) { $name = "tiktok-$videoId.mp4" }
    $res.AddHeader('X-File-Name', $name)
    $res.AddHeader('X-Import-Method', $method)
    if ($videoId) { $res.AddHeader('X-Video-Id', $videoId) }
    Send-File $res $filePath
    Write-Host "Import OK ($method): $((Get-Item $filePath).Length) bytes"
  } finally {
    Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch {
  Write-Host "Cannot listen on port $Port : $($_.Exception.Message)"
  Write-Host "Try another port: start.cmd -Port 8790"
  exit 1
}
$url = "http://localhost:$Port/"
Write-Host "RankShorts is running: $url  (Ctrl+C to stop)"
$yt0 = Find-YtDlp
if ($yt0) { Write-Host "yt-dlp: $yt0" } else { Write-Host "yt-dlp not found - link import is disabled. Install it with: winget install yt-dlp" }
if (-not $NoBrowser) { Start-Process $url }

try {
  while ($listener.IsListening) {
    $task = $listener.GetContextAsync()
    while (-not $task.AsyncWaitHandle.WaitOne(250)) { }
    $ctx = $task.GetAwaiter().GetResult()
    $req = $ctx.Request
    $res = $ctx.Response
    try {
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
      if ($path -eq '/api/status') {
        $yt = Find-YtDlp
        $ver = ''
        if ($yt) { try { $ver = "$(& $yt --version 2>$null | Select-Object -First 1)" } catch { } }
        Send-Json $res @{ ok = $true; ytdlp = [bool]$yt; version = $ver; tiktok = $true }
      }
      elseif ($path -eq '/api/resolve') {
        # Any TikTok link (short, redirecting, with tracking parameters) -> canonical video address.
        $target = $req.QueryString['url']
        if (-not $target -or $target.Length -gt 2000 -or $target -notmatch '^https?://[^\s"''<>`]+$') {
          Send-Json $res @{ error = 'bad_url' } 400
        } else {
          $tt = Resolve-TikTokUrl $target
          if ($tt.ok) { Send-Json $res @{ url = $tt.url; id = $tt.id; user = $tt.user } }
          else { Send-ImportError $res $tt }
        }
      }
      elseif ($path -eq '/api/import') {
        Invoke-Import $req $res
      }
      else {
        if ($path.EndsWith('/')) { $path += 'index.html' }
        $full = [IO.Path]::GetFullPath((Join-Path $Root $path.TrimStart('/')))
        if (-not $full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)) {
          Send-Json $res @{ error = 'forbidden' } 403
        } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
          Send-File $res $full
        } else {
          Send-Json $res @{ error = 'not_found' } 404
        }
      }
    } catch {
      try { Send-Json $res @{ error = 'server_error'; details = "$($_.Exception.Message)" } 500 } catch { }
    } finally {
      try { $res.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
}
