# SSH tunnel to VPS namecoind JSON-RPC (localhost only on the server).
# Usage from repo root:
#   powershell -File scripts/dev-vps.ps1
# Then open http://127.0.0.1:3100
# Ctrl+C stops node; the tunnel process is stopped afterward.

$ErrorActionPreference = "Stop"
$HostName = "nmc-vps"
$LocalRpc = 18336
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

$ssh = Get-Command ssh -ErrorAction Stop
function Test-LocalPort([int]$Port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(400)
    if ($ok -and $c.Connected) { $c.Close(); return $true }
    $c.Close()
  } catch { }
  return $false
}

$inUse = Test-LocalPort $LocalRpc
if (-not $inUse) {
  Write-Host "Opening SSH tunnel localhost:$LocalRpc -> nmc-vps:127.0.0.1:8336"
  $tun = Start-Process -FilePath $ssh.Source -ArgumentList @(
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-L", "${LocalRpc}:127.0.0.1:8336",
    $HostName
  ) -PassThru -WindowStyle Hidden
} else {
  Write-Host "Port $LocalRpc already listening — reusing existing tunnel"
  $tun = $null
}

$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 250
  if (Test-LocalPort $LocalRpc) {
    $ready = $true
    break
  }
}
if (-not $ready) {
  throw "Tunnel did not bind 127.0.0.1:$LocalRpc. Check: ssh $HostName"
}

$env:NODE_ENV = "development"
try {
  if (Get-Command npm -ErrorAction SilentlyContinue) {
    npm run dev
  } else {
    node --watch app.js
  }
} finally {
  if ($tun -and -not $tun.HasExited) {
    Stop-Process -Id $tun.Id -Force -ErrorAction SilentlyContinue
  }
}
