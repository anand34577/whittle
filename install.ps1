# Whittle installer for Windows. In PowerShell:
#
#   irm https://raw.githubusercontent.com/anand34577/whittle/main/install.ps1 | iex
#
# Installs the desktop app for the current user (no administrator rights needed).
# A specific release:  $env:WHITTLE_VERSION = "0.2.0"; irm ... | iex
# The download is checked against the release's SHA256SUMS.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "anand34577/whittle"
$version = "$env:WHITTLE_VERSION".TrimStart("v")
$api = if ($version) { "https://api.github.com/repos/$repo/releases/tags/v$version" } else { "https://api.github.com/repos/$repo/releases/latest" }

try {
  $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "whittle-installer" }
} catch {
  Write-Host "Could not reach GitHub, or release '$(if ($version) { $version } else { 'latest' })' doesn't exist." -ForegroundColor Red
  return
}

$setup = $release.assets | Where-Object { $_.name -like "*_x64-setup.exe" } | Select-Object -First 1
if (-not $setup) {
  Write-Host "Release $($release.tag_name) has no Windows installer." -ForegroundColor Red
  return
}

$file = Join-Path $env:TEMP $setup.name
Write-Host "Downloading $($setup.name)"
Invoke-WebRequest -Uri $setup.browser_download_url -OutFile $file -UseBasicParsing

$sums = $release.assets | Where-Object { $_.name -eq "SHA256SUMS" } | Select-Object -First 1
if ($sums) {
  $text = (Invoke-WebRequest -Uri $sums.browser_download_url -UseBasicParsing).Content
  if ($text -is [byte[]]) { $text = [Text.Encoding]::UTF8.GetString($text) }
  $line = ($text -split "`n") | Where-Object { $_ -match ("\s" + [regex]::Escape($setup.name) + "\s*$") } | Select-Object -First 1
  if ($line) {
    $want = ($line -split "\s+")[0].ToLower()
    $got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower()
    if ($want -ne $got) {
      Remove-Item $file -Force
      Write-Host "Checksum mismatch for $($setup.name). The download may be damaged; try again." -ForegroundColor Red
      return
    }
  }
}

Write-Host "Installing Whittle $($release.tag_name)"
Start-Process -FilePath $file -ArgumentList "/S" -Wait
Remove-Item $file -Force -ErrorAction SilentlyContinue
Write-Host "Whittle $($release.tag_name) is installed. Find it in the Start menu." -ForegroundColor Green
