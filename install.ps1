# Whittle installer for Windows. In PowerShell:
#
#   irm https://raw.githubusercontent.com/anand34577/whittle/main/install.ps1 | iex
#
# Installs or upgrades the desktop app for the current user (no administrator rights needed).
# A specific release:  $env:WHITTLE_VERSION = "0.2.0"; irm ... | iex
# Uninstall:           $env:WHITTLE_ACTION = "uninstall"; irm ... | iex
#   (your .whittle files and their version history are never touched)
# The download is checked against the release's SHA256SUMS.

$ErrorActionPreference = "Stop"

# An existing installation, from the uninstall registry keys the installer writes.
function Get-WhittleInstall {
  $keys = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
          "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
          "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq "Whittle" } |
    Select-Object -First 1
}

$existing = Get-WhittleInstall
if ("$env:WHITTLE_ACTION" -eq "uninstall") {
  if (-not $existing) {
    Write-Host "Whittle isn't installed." -ForegroundColor Yellow
    return
  }
  Write-Host "Uninstalling Whittle $($existing.DisplayVersion)"
  # The uninstall string can carry arguments after the quoted program path (audit X-7).
  $u = "$($existing.UninstallString)".Trim()
  if ($u.StartsWith('"')) { $end = $u.IndexOf('"', 1); $cmd = $u.Substring(1, $end - 1); $rest = $u.Substring($end + 1).Trim() }
  else { $cmd = $u; $rest = "" }
  $argList = @("/S"); if ($rest) { $argList = @($rest, "/S") }
  Start-Process -FilePath $cmd -ArgumentList $argList -Wait
  Write-Host "Whittle is uninstalled. Your designs were left in place." -ForegroundColor Green
  return
}
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow with the progress bar on
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "anand34577/whittle"
$version = "$env:WHITTLE_VERSION".TrimStart("v")
# The release's SHA256SUMS lists every file, so no GitHub API call (and no API rate limit) is needed.
$base = if ($version) { "https://github.com/$repo/releases/download/v$version" } else { "https://github.com/$repo/releases/latest/download" }

try {
  $sums = (Invoke-WebRequest -Uri "$base/SHA256SUMS" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
} catch {
  Write-Host "Could not download release '$(if ($version) { $version } else { 'latest' })' from GitHub. Check your internet connection, or the version number." -ForegroundColor Red
  return
}

$line = ($sums -split "`n") | Where-Object { $_ -match "_x64-setup\.exe\s*$" } | Select-Object -First 1
if (-not $line) {
  Write-Host "This release has no Windows installer." -ForegroundColor Red
  return
}
$want, $name = ($line.Trim() -split "\s+\*?", 2)
$tag = $name -replace '^Whittle_(.+)_x64-setup\.exe$', 'v$1'

$file = Join-Path $env:TEMP $name
Write-Host "Downloading $name"
Invoke-WebRequest -Uri "$base/$name" -OutFile $file -UseBasicParsing

$got = (Get-FileHash -Algorithm SHA256 -Path $file).Hash
if ($got -ne $want) {
  Remove-Item $file -Force
  Write-Host "Checksum mismatch for $name. The download may be damaged; try again." -ForegroundColor Red
  return
}

if ($existing -and ("v$($existing.DisplayVersion)" -eq $tag) -and "$env:WHITTLE_ACTION" -ne "reinstall") {
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  Write-Host "Whittle $tag is already installed and up to date. (To repair it: `$env:WHITTLE_ACTION = 'reinstall' before running this.)" -ForegroundColor Green
  return
}
if ($existing) {
  # The installer replaces the program in place; settings, recent files and designs are kept.
  Get-Process -Name "whittle-desktop", "Whittle" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Close Whittle to continue (save your work first)..." -ForegroundColor Yellow
    $_.WaitForExit()
  }
  Write-Host "Upgrading Whittle $($existing.DisplayVersion) to $tag"
} else {
  Write-Host "Installing Whittle $tag"
}
Start-Process -FilePath $file -ArgumentList "/S" -Wait
Remove-Item $file -Force -ErrorAction SilentlyContinue
Write-Host "Whittle $tag is installed. Find it in the Start menu." -ForegroundColor Green
