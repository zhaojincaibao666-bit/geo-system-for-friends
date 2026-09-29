param(
  [Parameter(Mandatory = $true)]
  [string] $Endpoint
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
$secretStore = Join-Path $PSScriptRoot "secret-store.ps1"
$requestBase64 = [Console]::In.ReadToEnd().Trim()
if ([string]::IsNullOrWhiteSpace($requestBase64)) { throw "Doubao request body is required" }
$requestJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($requestBase64))

$apiKey = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $secretStore -Action get -Name "doubao-ark-api-key"
if ([string]::IsNullOrWhiteSpace($apiKey)) { throw "Doubao API key is not configured" }

try {
  # Do not pass API text through the PowerShell console encoding. Both directions
  # use bytes/Base64 so Chinese prompts and Chinese model responses remain UTF-8.
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(90)
  $client.DefaultRequestHeaders.Authorization = [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $apiKey)
  $content = [System.Net.Http.StringContent]::new($requestJson, [System.Text.Encoding]::UTF8, "application/json")
  $response = $client.PostAsync($Endpoint, $content).GetAwaiter().GetResult()
  $responseBytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
  if (-not $response.IsSuccessStatusCode) {
    $errorBody = [System.Text.Encoding]::UTF8.GetString($responseBytes)
    throw "Doubao API HTTP $([int]$response.StatusCode): $errorBody"
  }
  [Console]::Out.Write([System.Convert]::ToBase64String($responseBytes))
} finally {
  if ($null -ne $client) { $client.Dispose() }
  if ($null -ne $content) { $content.Dispose() }
  $apiKey = $null
  $requestBase64 = $null
  $requestJson = $null
}
