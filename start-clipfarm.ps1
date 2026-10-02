$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules\electron\dist\electron.exe"))) {
    throw "Electron fehlt noch. Starte zuerst 'npm install' im clipfarm-Projekt."
}

Push-Location $projectRoot
try {
    npm.cmd run desktop
    if ($LASTEXITCODE -ne 0) { throw "clipfarm wurde mit Fehlercode $LASTEXITCODE beendet." }
} finally {
    Pop-Location
}
