param([switch]$NoBrowser, [int]$Port = 4317)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$runtimeDir = Join-Path $projectRoot '.runtime'
$sha = [Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))
$workspaceId = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant().Substring(0,16)
$sha.Dispose()
$mutex = [Threading.Mutex]::new($false, "Local\LifeCockpit_$workspaceId")
$hasLock = $false
$child = $null
try {
    if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid local port.' }
    $hasLock = $mutex.WaitOne(0)
    if (-not $hasLock) { throw 'The application is already starting. Please wait a few seconds.' }
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $url = "http://127.0.0.1:$Port"
    $existing = $null
    try { $existing = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2 } catch {}
    if ($null -ne $existing) {
        if ($existing.app -ne 'life-cockpit' -or $existing.workspaceId -ne $workspaceId) {
            throw "Port $Port is used by a different application. No process was changed."
        }
        if (-not $NoBrowser) { Start-Process $url }
        Write-Output "READY $url (existing process)"
        exit 0
    }
    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeVersion = & $nodePath --version
    if ($nodeVersion -notmatch '^v24\.' -or [version]$nodeVersion.TrimStart('v') -lt [version]'24.16.0') {
        throw 'This version requires Node.js 24.16 or a later Node.js 24 release.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) {
        throw 'The application build is missing. Run npm install and npm run build in the project first.'
    }
    $stdout = Join-Path $runtimeDir 'server.stdout.log'
    $stderr = Join-Path $runtimeDir 'server.stderr.log'
    $previousPort = $env:PCOS_PORT
    $previousData = $env:PCOS_DATA_DIR
    $previousOrigins = $env:PCOS_ALLOWED_ORIGINS
    try {
        $env:PCOS_PORT = [string]$Port
        $env:PCOS_DATA_DIR = Join-Path $projectRoot 'data'
        $env:PCOS_ALLOWED_ORIGINS = $null
        $entry = Join-Path $projectRoot 'server\index.ts'
        $child = Start-Process -FilePath $nodePath -ArgumentList @('"' + $entry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    } finally {
        $env:PCOS_PORT = $previousPort
        $env:PCOS_DATA_DIR = $previousData
        $env:PCOS_ALLOWED_ORIGINS = $previousOrigins
    }
    $healthy = $false
    for ($i=0; $i -lt 50; $i++) {
        $child.Refresh()
        if ($child.HasExited) { throw "Application startup failed. See $stderr" }
        try {
            $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1
            if ($health.app -eq 'life-cockpit' -and $health.workspaceId -eq $workspaceId -and $health.processId -eq $child.Id) { $healthy=$true; break }
        } catch {}
        Start-Sleep -Milliseconds 200
    }
    if (-not $healthy) { throw "Application did not become ready. See $stderr" }
    @{ processId=$child.Id; port=$Port; workspaceId=$workspaceId; startedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeDir 'server.json') -Encoding UTF8
    if (-not $NoBrowser) { Start-Process $url }
    Write-Output "READY $url"
} catch {
    if ($null -ne $child) {
        $child.Refresh()
        if (-not $child.HasExited) { Stop-Process -Id $child.Id }
    }
    $message = $_.Exception.Message
    Write-Error $message -ErrorAction Continue
    if (-not $NoBrowser) {
        $popup = New-Object -ComObject WScript.Shell
        $null = $popup.Popup($message, 0, 'Life Cockpit', 16)
    }
    exit 1
} finally {
    if ($hasLock) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
