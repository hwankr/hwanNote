param(
  [switch]$InstallDependencies
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-CheckResult {
  param(
    [string]$Name,
    [bool]$Ok,
    [string]$Detail
  )

  $status = if ($Ok) { '[OK]' } else { '[WARN]' }
  Write-Host "$status $Name - $Detail"
}

function Get-CommandVersion {
  param(
    [string]$Command,
    [string]$Arguments = '--version'
  )

  try {
    $output = & $Command $Arguments 2>$null
    if ($LASTEXITCODE -eq 0 -and $output) {
      return ($output | Select-Object -First 1).ToString().Trim()
    }
  } catch {
    return $null
  }

  return $null
}

function Test-NodeRequirement {
  $nodeVersion = Get-CommandVersion -Command 'node' -Arguments '--version'
  if (-not $nodeVersion) {
    return @{ Ok = $false; Detail = 'Node.js가 없습니다. 프로젝트는 Node.js >= 20 이 필요합니다.' }
  }

  $major = [int](($nodeVersion -replace '^v', '').Split('.')[0])
  if ($major -lt 20) {
    return @{ Ok = $false; Detail = "Node.js $nodeVersion 감지됨. Node.js >= 20 으로 업그레이드하세요." }
  }

  return @{ Ok = $true; Detail = "Node.js $nodeVersion" }
}

function Test-WebView2Runtime {
  $clientId = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
  $registryPaths = @(
    "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\$clientId",
    "HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\$clientId",
    "HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\$clientId"
  )

  foreach ($path in $registryPaths) {
    try {
      $value = (Get-ItemProperty -Path $path -Name pv -ErrorAction Stop).pv
      if ($value) {
        return @{ Ok = $true; Detail = "WebView2 Runtime $value" }
      }
    } catch {
      continue
    }
  }

  return @{ Ok = $false; Detail = 'WebView2 Runtime을 찾지 못했습니다. 필요 시 Evergreen Bootstrapper를 설치하세요.' }
}

function Test-VsBuildTools {
  try {
    $cl = Get-Command 'cl.exe' -ErrorAction Stop
    return @{ Ok = $true; Detail = "MSVC 도구 확인: $($cl.Source)" }
  } catch {
  }

  $vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $vswhere) {
    return @{ Ok = $true; Detail = "Visual Studio Installer 확인: $vswhere" }
  }

  return @{ Ok = $false; Detail = 'Visual Studio C++ Build Tools 2022 설치 여부를 확인하세요.' }
}

$gitVersion = Get-CommandVersion -Command 'git'
$npmVersion = Get-CommandVersion -Command 'npm'
$rustVersion = Get-CommandVersion -Command 'rustc'
$cargoVersion = Get-CommandVersion -Command 'cargo'

$checks = @(
  @{ Name = 'Git'; Result = @{ Ok = [bool]$gitVersion; Detail = if ($gitVersion) { $gitVersion } else { 'git 명령을 찾지 못했습니다.' } } },
  @{ Name = 'Node.js'; Result = Test-NodeRequirement },
  @{ Name = 'npm'; Result = @{ Ok = [bool]$npmVersion; Detail = if ($npmVersion) { $npmVersion } else { 'npm 명령을 찾지 못했습니다.' } } },
  @{ Name = 'Rust'; Result = @{ Ok = [bool]$rustVersion; Detail = if ($rustVersion) { $rustVersion } else { 'rustc 명령을 찾지 못했습니다.' } } },
  @{ Name = 'Cargo'; Result = @{ Ok = [bool]$cargoVersion; Detail = if ($cargoVersion) { $cargoVersion } else { 'cargo 명령을 찾지 못했습니다.' } } },
  @{ Name = 'MSVC Build Tools'; Result = Test-VsBuildTools },
  @{ Name = 'WebView2 Runtime'; Result = Test-WebView2Runtime }
)

Write-Host 'HwanNote Windows 개발 환경 점검'
Write-Host '--------------------------------'

$hasWarnings = $false
foreach ($check in $checks) {
  Write-CheckResult -Name $check.Name -Ok $check.Result.Ok -Detail $check.Result.Detail
  if (-not $check.Result.Ok) {
    $hasWarnings = $true
  }
}

if ($InstallDependencies) {
  Write-Host ''
  Write-Host 'npm install 실행 중...'
  & npm install
}

Write-Host ''
if ($hasWarnings) {
  Write-Host '일부 항목이 부족합니다. Tauri Windows 개발 요구사항을 먼저 맞춰 주세요.'
  exit 1
}

Write-Host '필수 항목 점검이 끝났습니다. 다음 단계: npm install -> npm run dev'
