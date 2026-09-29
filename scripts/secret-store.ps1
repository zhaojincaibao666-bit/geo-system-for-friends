param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("set", "get", "remove")]
  [string] $Action,
  [Parameter(Mandatory = $true)]
  [string] $Name
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$secretDirectory = Join-Path $root "data\secrets"
$secretPath = Join-Path $secretDirectory "$Name.bin"
New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null

if ($Action -eq "set") {
  $plainText = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($plainText)) { throw "API Key 不能为空" }
  try {
    # On Windows, ConvertFrom-SecureString uses the current user's DPAPI key.
    # The resulting ciphertext cannot be decrypted by another Windows account.
    $secureString = ConvertTo-SecureString -String $plainText -AsPlainText -Force
    $encrypted = ConvertFrom-SecureString -SecureString $secureString
    # DPAPI ciphertext is ASCII. Avoid a UTF-8 BOM: it becomes part of the
    # ciphertext when read back by Windows PowerShell and breaks decryption.
    Set-Content -LiteralPath $secretPath -Value $encrypted -NoNewline -Encoding ascii
  } finally {
    $plainText = $null
    $secureString = $null
  }
}

if ($Action -eq "get") {
  if (-not (Test-Path -LiteralPath $secretPath)) { throw "未找到已配置的 API Key" }
  # Compatibility for keys saved by earlier versions with a UTF-8 BOM.
  $encrypted = (Get-Content -LiteralPath $secretPath -Raw -Encoding utf8).TrimStart([char]0xFEFF).Trim()
  $secureString = ConvertTo-SecureString -String $encrypted
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureString)
  try {
    [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if ($Action -eq "remove") {
  if (Test-Path -LiteralPath $secretPath) {
    Remove-Item -LiteralPath $secretPath -Force
  }
}
