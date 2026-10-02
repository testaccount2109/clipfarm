$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceFile = Join-Path $projectRoot "updater\Program.cs"
$outputDirectory = Join-Path $projectRoot "release"
$outputFile = Join-Path $outputDirectory "Clipfarm-Updater.exe"
$iconFile = Join-Path $projectRoot "desktop\branding\clipfarm.ico"
$compilerCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $compiler) { throw "Der Windows-C#-Compiler von .NET Framework wurde nicht gefunden." }
if (-not (Test-Path -LiteralPath $sourceFile)) { throw "Updater-Quellcode fehlt: $sourceFile" }
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$arguments = @(
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    "/out:$outputFile",
    "/win32icon:$iconFile",
    "/reference:System.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Runtime.Serialization.dll",
    "/reference:System.IO.Compression.dll",
    $sourceFile
)

& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "Updater-Kompilierung fehlgeschlagen (Exitcode $LASTEXITCODE)." }

Write-Output "Updater erstellt: $outputFile"
