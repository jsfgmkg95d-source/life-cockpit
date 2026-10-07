param([switch]$Quiet)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\')
$statePath = Join-Path $projectRoot '.runtime\server.json'
try {
    if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'No launcher-managed process.'; exit 0 }
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$state.processId)"
    if ($null -eq $serverProcess) { Write-Output 'Already stopped.'; exit 0 }
    $entry = Join-Path $projectRoot 'server\index.ts'
    if ($serverProcess.Name -ne 'node.exe' -or -not $serverProcess.CommandLine.Contains($entry)) {
        throw 'Saved process ID belongs to another application. No process was stopped.'
    }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($state.port)/api/health" -TimeoutSec 2
    if ($health.app -ne 'life-cockpit' -or $health.workspaceId -ne $state.workspaceId -or $health.processId -ne $state.processId) {
        throw 'The running application does not match the launcher record. No process was stopped.'
    }
    Stop-Process -Id ([int]$state.processId)
    Write-Output 'STOPPED Life Cockpit'
} catch {
    Write-Error $_.Exception.Message -ErrorAction Continue
    if (-not $Quiet) {
        $popup = New-Object -ComObject WScript.Shell
        $null = $popup.Popup($_.Exception.Message, 0, 'Life Cockpit', 16)
    }
    exit 1
}
