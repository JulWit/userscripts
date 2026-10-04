<#
.SYNOPSIS
  Serves the repository over HTTP on localhost, so that the fixture pages in
  tests/fixtures/ can be opened in a browser without Node.js.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File tests/serve.ps1
  Then open http://localhost:8765/tests/fixtures/article.html.
#>
param(
  [int]$Port = 8765,
  [string]$Root = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'
$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$types = @{
  '.css' = 'text/css; charset=utf-8'
  '.html' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'
}

$listener = New-Object System.Net.HttpListener
# Only reachable from this machine.
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $rootPath on http://localhost:$Port/ (Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $response = $context.Response
    $path = ''
    try {
      $path = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath)
      $file = [IO.Path]::GetFullPath(
          (Join-Path $rootPath $path.TrimStart('/')))
      # Paths outside the repository (../) are not served.
      if ($file.StartsWith($rootPath) -and
          (Test-Path -LiteralPath $file -PathType Leaf)) {
        $bytes = [IO.File]::ReadAllBytes($file)
        $extension = [IO.Path]::GetExtension($file)
        $response.ContentType = if ($types.ContainsKey($extension)) {
          $types[$extension]
        } else {
          'application/octet-stream'
        }
        $response.Headers.Add('Cache-Control', 'no-store')
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $response.StatusCode = 404
      }
    } catch {
      $response.StatusCode = 500
      Write-Warning $_
    } finally {
      $response.Close()
    }
    Write-Host "$($context.Request.HttpMethod) $path $($response.StatusCode)"
  }
} finally {
  $listener.Stop()
}
