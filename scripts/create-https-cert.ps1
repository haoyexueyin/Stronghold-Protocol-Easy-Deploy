# Generate an exportable local certificate without installing a trusted root or requiring administrator rights.
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$certDir = Join-Path $projectRoot 'certs'
$pfxFile = Join-Path $certDir 'local.pfx'
$renewing = $false
if (Test-Path -LiteralPath $pfxFile) {
    $existing = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfxFile, '')
    try {
        if ($existing.NotAfter -gt (Get-Date).AddDays(7)) {
            Write-Host "[HTTPS] Using certificate: $pfxFile"
            exit 0
        }
        $renewing = $true
    } finally { $existing.Dispose() }
}
New-Item -ItemType Directory -Path $certDir -Force | Out-Null
$san = @('DNS=localhost', 'IPAddress=127.0.0.1', 'IPAddress=::1')
Get-NetIPAddress -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.IPAddress -notmatch '^(127\.|::1$|fe80:|169\.254\.)') { $san += "IPAddress=$($_.IPAddress)" }
}
$localCert = $null
try {
    $localCert = New-SelfSignedCertificate -Subject 'CN=localhost' -FriendlyName 'Stronghold Protocol local HTTPS' `
        -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears(1) -TextExtension @("2.5.29.17={text}$($san -join '&')", '2.5.29.37={text}1.3.6.1.5.5.7.3.1')
    [System.IO.File]::WriteAllBytes($pfxFile, $localCert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, ''))
    Write-Host "[HTTPS] Created self-signed certificate: $pfxFile"
    Write-Host '[HTTPS] Browsers will show a certificate warning. This file contains a private key; do not share it.'
    if ($renewing) {
        Write-Host '[HTTPS] Certificate renewed. A running server still uses the OLD certificate.' -ForegroundColor Yellow
        Write-Host '[HTTPS] Stop its window with Ctrl+C, then run start-https-windows.bat again to load the new certificate.' -ForegroundColor Yellow
    }
} finally {
    if ($localCert) { Remove-Item -LiteralPath $localCert.PSPath -Force }
}
