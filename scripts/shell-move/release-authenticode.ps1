# release-authenticode.ps1 -Path <setup.exe>: the Authenticode signature of the published Windows setup (shell-batch-checks.yml
# only=release-verify, release-assets-win). Run under PowerShell 7 (`shell: pwsh`): Windows PowerShell 5.1 started from a pwsh
# parent inherits PowerShell 7's PSModulePath and cannot load Microsoft.PowerShell.Security (scripts/stage-preview-browser.ts
# drops the variable for that reason), so nothing here starts powershell.exe.
# release.yml signs nothing of the setup and checks nothing of it (AGENTS.md › Signing is the Mac's certificate), so the status and
# the signer are EVIDENCE lines. What fails: a signature that is there and does not match the bytes (HashMismatch), or a format
# Authenticode cannot read (NotSupportedFileFormat, Incompatible). Prints the same ok:/FAILED:/EVIDENCE: lines as the bash checks.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Path
$certificate = $signature.SignerCertificate
Write-Output "EVIDENCE: Get-AuthenticodeSignature $(Split-Path -Leaf $Path): status $($signature.Status), message '$($signature.StatusMessage)'"
if ($certificate) {
  Write-Output "EVIDENCE: signer $($certificate.Subject); issuer $($certificate.Issuer); thumbprint $($certificate.Thumbprint); valid $($certificate.NotBefore.ToString('o')) to $($certificate.NotAfter.ToString('o'))"
  Write-Output "EVIDENCE: timestamp countersignature: $(if ($signature.TimeStamperCertificate) { $signature.TimeStamperCertificate.Subject } else { 'none' })"
} else {
  Write-Output 'EVIDENCE: no signer certificate: the setup is not Authenticode-signed (release.yml does not sign it)'
}
$broken = @('HashMismatch', 'NotSupportedFileFormat', 'Incompatible')
if ($broken -contains [string]$signature.Status) {
  Write-Output "FAILED: the Authenticode signature is $($signature.Status): $($signature.StatusMessage)"
  exit 1
}
Write-Output "ok: the Authenticode status is $($signature.Status), not a broken signature"
