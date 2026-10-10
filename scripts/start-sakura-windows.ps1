# Prompt for a secret locally and pass it through the environment, never the command line.
[CmdletBinding(PositionalBinding = $false)]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @())
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 22/24 is required. Install Node.js first.' }
$nodeVersion = (& node -v) -replace '^v', ''
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.Split('.')[0]) -lt 22) { throw 'Node.js 22 or newer is required.' }
if (-not ($env:SP_TLS_PFX -or $env:SP_TLS_CERT -or $env:SP_TLS_KEY)) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'create-https-cert.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'HTTPS certificate creation failed.' }
}
$oldToken = $env:NATFRP_TOKEN
$oldHttps = $env:SP_HTTPS
$secret = $null
$secretPointer = [IntPtr]::Zero
try {
    Write-Host '樱花一键联机：复用兼容 TCP 隧道，或自动选择可用免费节点创建隧道。'
    $secret = Read-Host '请输入樱花访问密钥（输入不会显示）' -AsSecureString
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $env:NATFRP_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
    if (-not $env:NATFRP_TOKEN) { throw 'Access key is empty.' }
    $env:SP_HTTPS = '1'
    & node scripts/launch.mjs --sakura @Rest
    $launchCode = $LASTEXITCODE
} finally {
    if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    if ($secret) { $secret.Dispose() }
    $env:NATFRP_TOKEN = $oldToken
    $env:SP_HTTPS = $oldHttps
}
exit $launchCode
