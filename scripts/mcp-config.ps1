<#
.SYNOPSIS
  Writes .mcp.json (Claude Code project-scope MCP config) with the absolute path of this checkout,
  so the file never has to contain anyone's home directory. .mcp.json is git-ignored; run this once
  per clone (and again if you move the directory).
.EXAMPLE
  .\scripts\mcp-config.ps1                       write .mcp.json
  .\scripts\mcp-config.ps1 -BridgePort 19800     also set GMA3_BRIDGE_PORT (e.g. for an SSH tunnel on another local port)
  .\scripts\mcp-config.ps1 -Print                print the JSON instead of writing (paste into claude_desktop_config.json)
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 65535)] [int] $BridgePort,
  [switch] $Print
)
$ErrorActionPreference = 'Stop'
$root  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$entry = Join-Path $root 'dist\index.js'

$server = [ordered]@{ command = 'node'; args = @($entry) }
if ($BridgePort) { $server.env = [ordered]@{ GMA3_BRIDGE_PORT = "$BridgePort" } }
$json = [ordered]@{ mcpServers = [ordered]@{ gma3 = $server } } | ConvertTo-Json -Depth 5

if ($Print) {
  $json
} else {
  $target = Join-Path $root '.mcp.json'
  # UTF-8 without BOM: Out-File on Windows PowerShell 5 would add one, which JSON parsers reject.
  [System.IO.File]::WriteAllText($target, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
  Write-Host "Wrote $target"
  if (-not (Test-Path $entry)) { Write-Warning "dist\index.js does not exist yet; run 'npm run build'" }
}
