$ErrorActionPreference = "Stop"

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class ClipfarmHotkeys {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Message { public IntPtr HWnd; public uint MessageId; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Point; }
    [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern int GetMessage(out Message message, IntPtr hWnd, uint min, uint max);
}
'@

$baseUrl = "http://127.0.0.1:4174"
$modNoRepeat = 0x4000

function Convert-HotkeySpec([string]$spec) {
    $parts = $spec.ToUpperInvariant().Split("+")
    $keyPart = $parts[$parts.Length - 1]
    [uint32]$modifiers = 0
    foreach ($part in $parts[0..($parts.Length - 2)]) {
        switch ($part) {
            "ALT" { $modifiers = $modifiers -bor 0x0001 }
            "CTRL" { $modifiers = $modifiers -bor 0x0002 }
            "SHIFT" { $modifiers = $modifiers -bor 0x0004 }
            "WIN" { $modifiers = $modifiers -bor 0x0008 }
        }
    }
    if ($keyPart -match '^F([1-9]|1[0-2])$') { $virtualKey = 0x6F + [int]$Matches[1] }
    elseif ($keyPart -match '^[A-Z0-9]$') { $virtualKey = [byte][char]$keyPart }
    else { throw "Ungültiger Hotkey: $spec" }
    return [pscustomobject]@{ Key = [uint32]$virtualKey; Modifiers = $modifiers; Label = $spec }
}

$config = Invoke-RestMethod -Uri "$baseUrl/api/config"
$hotkeyConfig = $config.config.hotkeys
$hotkeys = @(
    @{ Id = 1; Spec = [string]$hotkeyConfig.save; Action = "save" },
    @{ Id = 2; Spec = [string]$hotkeyConfig.toggle; Action = "toggle" },
    @{ Id = 3; Spec = [string]$hotkeyConfig.microphone; Action = "microphone" }
) | ForEach-Object {
    $parsed = Convert-HotkeySpec $_.Spec
    [pscustomobject]@{ Id = $_.Id; Key = $parsed.Key; Modifiers = $parsed.Modifiers; Label = $parsed.Label; Action = $_.Action }
}

foreach ($hotkey in $hotkeys) {
    if (-not [ClipfarmHotkeys]::RegisterHotKey([IntPtr]::Zero, $hotkey.Id, ($hotkey.Modifiers -bor $modNoRepeat), $hotkey.Key)) {
        throw "Konnte globalen Hotkey $($hotkey.Label) nicht registrieren."
    }
}

Write-Host "clipfarm global hotkeys active: $($hotkeys.Label -join ', ')"

function Invoke-ClipfarmPost([string]$path, $body = $null) {
    try {
        if ($null -eq $body) { Invoke-RestMethod -Method Post -Uri "$baseUrl$path" | Out-Null; return }
        Invoke-RestMethod -Method Post -Uri "$baseUrl$path" -ContentType "application/json" -Body ($body | ConvertTo-Json -Compress) | Out-Null
    } catch { Write-Warning "clipfarm request failed for $path`: $($_.Exception.Message)" }
}

try {
    while ($true) {
        $message = New-Object ClipfarmHotkeys+Message
        $result = [ClipfarmHotkeys]::GetMessage([ref]$message, [IntPtr]::Zero, 0, 0)
        if ($result -le 0) { break }
        if ($message.MessageId -ne 0x0312) { continue }
        $trigger = $hotkeys | Where-Object { $_.Id -eq $message.WParam.ToUInt32() }
        switch ($trigger.Action) {
            "save" {
                try {
                    $currentConfig = Invoke-RestMethod -Uri "$baseUrl/api/config"
                    $session = Invoke-RestMethod -Uri "$baseUrl/api/session"
                    $game = if ($session.game) { $session.game } else { "Game" }
                    Invoke-ClipfarmPost "/api/clip/save" @{ seconds = $currentConfig.config.replayLength; game = $game }
                } catch { Write-Warning "clipfarm session lookup failed: $($_.Exception.Message)" }
            }
            "toggle" {
                $engine = Invoke-RestMethod -Uri "$baseUrl/api/engine"
                if ($engine.state -eq "running") { Invoke-ClipfarmPost "/api/engine/stop" } else { Invoke-ClipfarmPost "/api/engine/start" }
            }
            "microphone" { Invoke-ClipfarmPost "/api/audio/mic" }
        }
    }
}
finally {
    foreach ($hotkey in $hotkeys) { [ClipfarmHotkeys]::UnregisterHotKey([IntPtr]::Zero, $hotkey.Id) | Out-Null }
}
