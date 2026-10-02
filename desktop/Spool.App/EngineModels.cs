using System.Text.Json;
using System.Text.Json.Serialization;

namespace Spool.App;

public static class JsonDefaults
{
    public static JsonSerializerOptions Options { get; } = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true
    };

    public static JsonSerializerOptions IndentedOptions { get; } = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };
}

public sealed class EngineConfig
{
    [JsonPropertyName("replayLength")] public int ReplayLength { get; set; } = 30;
    [JsonPropertyName("resolution")] public string Resolution { get; set; } = "1920x1080";
    [JsonPropertyName("fps")] public int Fps { get; set; } = 60;
    [JsonPropertyName("bitrate")] public string Bitrate { get; set; } = "28M";
    [JsonPropertyName("encoder")] public string Encoder { get; set; } = "hevc_amf";
    [JsonPropertyName("quality")] public string Quality { get; set; } = "balanced";
    [JsonPropertyName("captureMethod")] public string CaptureMethod { get; set; } = "auto";
    [JsonPropertyName("hotkeys")] public Dictionary<string, string> Hotkeys { get; set; } = new(StringComparer.OrdinalIgnoreCase)
    {
        ["save"] = "F8", ["toggle"] = "F9", ["microphone"] = "F10"
    };
    [JsonPropertyName("microphoneDevice")] public string? MicrophoneDevice { get; set; }
    [JsonPropertyName("microphoneVolume")] public int MicrophoneVolume { get; set; } = 100;
    [JsonPropertyName("clipDirectory")] public string ClipDirectory { get; set; } = "";
    [JsonPropertyName("bufferDirectory")] public string BufferDirectory { get; set; } = "";
    [JsonPropertyName("maxStorageGb")] public int MaxStorageGb { get; set; } = 50;
    [JsonPropertyName("cleanupPolicy")] public string CleanupPolicy { get; set; } = "limit";
    [JsonPropertyName("backgroundPriority")] public bool BackgroundPriority { get; set; } = true;
}

public sealed class EngineSnapshot
{
    [JsonPropertyName("state")] public string State { get; set; } = "stopped";
    [JsonPropertyName("pid")] public int? Pid { get; set; }
    [JsonPropertyName("encoder")] public string? Encoder { get; set; }
    [JsonPropertyName("captureMethod")] public string? CaptureMethod { get; set; }
    [JsonPropertyName("captureTarget")] public string? CaptureTarget { get; set; }
    [JsonPropertyName("audioSource")] public string? AudioSource { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("micEnabled")] public bool MicEnabled { get; set; } = true;
    [JsonPropertyName("bufferSeconds")] public int BufferSeconds { get; set; }
    [JsonPropertyName("bufferReady")] public bool BufferReady { get; set; }
    [JsonPropertyName("config")] public EngineConfig Config { get; set; } = new();
}

public sealed class SessionSnapshot
{
    [JsonPropertyName("game")] public string? Game { get; set; }
    [JsonPropertyName("process")] public string? Process { get; set; }
    [JsonPropertyName("captureMethod")] public string? CaptureMethod { get; set; }
}

public sealed class MetricsSnapshot
{
    [JsonPropertyName("cpuPercent")] public double? CpuPercent { get; set; }
    [JsonPropertyName("hostCpuPercent")] public double? HostCpuPercent { get; set; }
    [JsonPropertyName("engineCpuPercent")] public double? EngineCpuPercent { get; set; }
    [JsonPropertyName("ramBytes")] public long? RamBytes { get; set; }
    [JsonPropertyName("gpuPercent")] public double? GpuPercent { get; set; }
    [JsonPropertyName("gpuAvailable")] public bool GpuAvailable { get; set; }
}

public sealed class ClipEntry
{
    [JsonPropertyName("file")] public string File { get; set; } = "";
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("game")] public string Game { get; set; } = "Game";
    [JsonPropertyName("thumbnail")] public string? Thumbnail { get; set; }
    [JsonPropertyName("savedAt")] public DateTimeOffset SavedAt { get; set; }
    [JsonPropertyName("sizeBytes")] public long SizeBytes { get; set; }
    [JsonPropertyName("seconds")] public int Seconds { get; set; }
    [JsonPropertyName("resolution")] public string? Resolution { get; set; }
    [JsonPropertyName("fps")] public string? Fps { get; set; }
    [JsonIgnore] public string? ThumbnailUri { get; set; }

    [JsonIgnore] public string Summary => $"{Game}  ·  {SavedAt.ToLocalTime():dd MMM yyyy, HH:mm}  ·  {Seconds}s  ·  {Resolution ?? "n/a"}  ·  {Fps ?? "n/a"}";
    [JsonIgnore] public string FileSize => SizeBytes < 1_000_000 ? $"{SizeBytes / 1024d:0} KB" : $"{SizeBytes / 1_000_000d:0.0} MB";
}

public sealed class AudioDevicesSnapshot
{
    [JsonPropertyName("devices")] public List<string> Devices { get; set; } = [];
    [JsonPropertyName("selected")] public string? Selected { get; set; }
    [JsonPropertyName("wasapiLoopback")] public bool WasapiLoopback { get; set; }
}

public sealed class ConfigEnvelope
{
    [JsonPropertyName("config")] public EngineConfig Config { get; set; } = new();
    [JsonPropertyName("engine")] public EngineSnapshot Engine { get; set; } = new();
}
