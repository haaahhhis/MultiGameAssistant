# Install or update MultiGameAssistant on Windows in one step, without clicks:
# for people, and for agents asked to install it from a link to this repository.
#
#   irm https://raw.githubusercontent.com/haaahhhis/MultiGameAssistant/main/scripts/install.ps1 | iex
#
# With options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/haaahhhis/MultiGameAssistant/main/scripts/install.ps1))) -Mirror https://ghproxy.net/ -NoLaunch
#
# It takes the newest stable release (the newest pre-release while there is no
# stable one, or with -Prerelease), picks the installer for this computer
# (x64 or ARM64), checks it against the SHA-256 GitHub publishes for it,
# installs it for the current user without asking anything (no administrator,
# the same place and data as before on an update), and starts the app.
# Messages are in English and the file is plain ASCII: Windows PowerShell 5.1
# reads a downloaded script as ASCII, and `iex` fails on a byte-order mark.
param(
  # Take the newest release even when it is a pre-release.
  [switch]$Prerelease,
  # A download mirror put in front of GitHub's file URLs, e.g. https://ghproxy.net/ (default: $env:MGA_MIRROR).
  [string]$Mirror = $env:MGA_MIRROR,
  # Install only; do not start the app afterwards.
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest's progress bar makes downloads many times slower in Windows PowerShell.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$repo = 'haaahhhis/MultiGameAssistant'
$headers = @{ 'User-Agent' = 'MultiGameAssistant-install'; 'Accept' = 'application/vnd.github+json' }

function Fail([string]$message) {
  Write-Host "MultiGameAssistant install failed: $message" -ForegroundColor Red
  throw $message
}

if ($env:OS -ne 'Windows_NT') { Fail 'MultiGameAssistant runs on Windows 10 / 11 only.' }
if ([Environment]::OSVersion.Version.Major -lt 10) { Fail 'MultiGameAssistant needs Windows 10 or 11.' }

# The real architecture, also from 32-bit PowerShell on a 64-bit Windows.
$machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($machine) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { Fail "this computer's processor ($machine) is not supported: x64 and ARM64 are." } }

Write-Host "Reading the releases of $repo ..."
$releases = @(Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/releases?per_page=20") | Where-Object { -not $_.draft }
$stable = @($releases | Where-Object { -not $_.prerelease })
$release = if (-not $Prerelease -and $stable.Count -gt 0) { $stable[0] } else { @($releases)[0] }
if ($null -eq $release) { Fail "$repo has no releases yet." }
$version = $release.tag_name -replace '^v', ''
if ($release.prerelease) { Write-Host "Taking pre-release $version (no stable release yet, or -Prerelease)." }

$asset = @($release.assets | Where-Object {
  $_.name -like 'MultiGameAssistant-Setup-*.exe' -and (($arch -eq 'arm64') -eq ($_.name -like '*-arm64.exe'))
})[0]
if ($null -eq $asset) { Fail "release $($release.tag_name) has no $arch installer." }
$digest = if ($asset.digest -match '^sha256:([0-9a-f]{64})$') { $Matches[1] } else { $null }
if ($null -eq $digest) { Fail "GitHub publishes no SHA-256 for $($asset.name), so it cannot be checked." }

# Already this version: nothing to download.
$installed = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like 'MultiGameAssistant*' } | Select-Object -First 1
$exe = $null
if ($null -ne $installed -and $installed.DisplayVersion -eq $version) {
  Write-Host "MultiGameAssistant $version is already installed."
} else {
  # Not in a project or install folder: a download is the computer's, not the app's.
  $dir = Join-Path $env:TEMP 'MultiGameAssistant-install'
  New-Item -ItemType Directory -Force $dir | Out-Null
  $file = Join-Path $dir $asset.name
  $url = $asset.browser_download_url
  if ($Mirror) { $url = $Mirror.TrimEnd('/') + '/' + $url }
  $size = [math]::Round($asset.size / 1MB, 1)
  Write-Host "Downloading $($asset.name) ($size MB) ..."
  try {
    Invoke-WebRequest -UseBasicParsing -Headers @{ 'User-Agent' = $headers['User-Agent'] } -Uri $url -OutFile $file
  } catch {
    if (-not $Mirror) { Fail "the download failed ($($_.Exception.Message)). If GitHub is slow or blocked here, try again with a mirror: -Mirror https://ghproxy.net/" }
    Fail "the download through $Mirror failed ($($_.Exception.Message))."
  }
  $hash = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLowerInvariant()
  if ($hash -ne $digest) {
    Remove-Item -Force $file
    Fail "$($asset.name) does not match the SHA-256 GitHub publishes for it (got $hash, expected $digest); it was deleted."
  }
  Write-Host 'Checked against GitHub''s SHA-256. Installing (no questions, for this user only) ...'
  # /S: electron-builder's silent install; an update closes the running app, keeps the data and the install folder.
  $setup = Start-Process -FilePath $file -ArgumentList '/S' -Wait -PassThru
  if ($setup.ExitCode -ne 0) { Fail "the installer exited with code $($setup.ExitCode)." }
  Remove-Item -Force $file -ErrorAction SilentlyContinue
  $installed = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like 'MultiGameAssistant*' } | Select-Object -First 1
  Write-Host "MultiGameAssistant $version is installed." -ForegroundColor Green
}

if ($null -ne $installed -and $installed.InstallLocation) { $exe = Join-Path $installed.InstallLocation 'MultiGameAssistant.exe' }
if ($null -eq $exe -or -not (Test-Path $exe)) {
  $exe = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\multigameassistant\MultiGameAssistant.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\MultiGameAssistant\MultiGameAssistant.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if ($null -eq $exe) { Fail 'the installer finished but MultiGameAssistant.exe was not found; start it from the Start menu.' }
Write-Host "Program: $exe"
if (-not $NoLaunch) {
  # Started directly, not through the new shortcut (that can fail right after installing).
  Start-Process -FilePath $exe
  Write-Host 'Started. Next: choose a model and enter its API key in the app (the first-run guide asks for it).'
}
