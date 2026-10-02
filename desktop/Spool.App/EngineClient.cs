using System.Net.Http.Json;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace Spool.App;

public sealed class EngineClient : IDisposable
{
    private readonly HttpClient _client;
    public Uri BaseAddress { get; }

    public EngineClient(Uri baseAddress)
    {
        BaseAddress = baseAddress;
        _client = new HttpClient { BaseAddress = baseAddress, Timeout = TimeSpan.FromSeconds(30) };
    }

    public async Task<EngineSnapshot> GetEngineAsync(CancellationToken cancellationToken = default) =>
        await GetAsync<EngineSnapshot>("api/engine", cancellationToken);

    public async Task<ConfigEnvelope> GetConfigAsync(CancellationToken cancellationToken = default) =>
        await GetAsync<ConfigEnvelope>("api/config", cancellationToken);

    public async Task<SessionSnapshot> GetSessionAsync(CancellationToken cancellationToken = default) =>
        await GetAsync<SessionSnapshot>("api/session", cancellationToken);

    public async Task<MetricsSnapshot> GetMetricsAsync(CancellationToken cancellationToken = default) =>
        await GetAsync<MetricsSnapshot>("api/metrics", cancellationToken);

    public async Task<List<ClipEntry>> GetClipsAsync(CancellationToken cancellationToken = default)
    {
        var result = await GetAsync<ClipListEnvelope>("api/clips", cancellationToken);
        foreach (var clip in result.Clips)
        {
            if (!string.IsNullOrWhiteSpace(clip.Thumbnail))
                clip.ThumbnailUri = new Uri(BaseAddress, clip.Thumbnail).ToString();
        }
        return result.Clips;
    }

    public async Task<AudioDevicesSnapshot> GetAudioDevicesAsync(CancellationToken cancellationToken = default) =>
        await GetAsync<AudioDevicesSnapshot>("api/audio/devices", cancellationToken);

    public Task<EngineSnapshot> StartEngineAsync(CancellationToken cancellationToken = default) =>
        PostAsync<EngineSnapshot>("api/engine/start", new { }, cancellationToken);

    public Task<EngineSnapshot> StopEngineAsync(CancellationToken cancellationToken = default) =>
        PostAsync<EngineSnapshot>("api/engine/stop", new { }, cancellationToken);

    public Task<ConfigEnvelope> UpdateConfigAsync(Dictionary<string, object?> patch, CancellationToken cancellationToken = default) =>
        PostAsync<ConfigEnvelope>("api/config", patch, cancellationToken);

    public async Task<ClipEntry?> SaveClipAsync(int seconds, string game, CancellationToken cancellationToken = default)
    {
        var result = await PostAsync<ClipSaveEnvelope>("api/clip/save", new { seconds, game }, cancellationToken);
        return result.Clip;
    }

    public Task<JsonElement> SetMicrophoneAsync(bool enabled, CancellationToken cancellationToken = default) =>
        PostAsync<JsonElement>("api/audio/mic/state", new { enabled }, cancellationToken);

    public Task<JsonElement> FileActionAsync(string route, string file, string? name = null, string? action = null, CancellationToken cancellationToken = default) =>
        PostAsync<JsonElement>($"api/file/{route}", new { file, name, action }, cancellationToken);

    public Task<JsonElement> OpenClipFolderAsync(CancellationToken cancellationToken = default) =>
        PostAsync<JsonElement>("api/file/folder", new { }, cancellationToken);

    private async Task<T> GetAsync<T>(string path, CancellationToken cancellationToken)
    {
        using var response = await _client.GetAsync(path, cancellationToken);
        return await ReadResponseAsync<T>(response, cancellationToken);
    }

    private async Task<T> PostAsync<T>(string path, object body, CancellationToken cancellationToken)
    {
        using var response = await _client.PostAsJsonAsync(path, body, JsonDefaults.Options, cancellationToken);
        return await ReadResponseAsync<T>(response, cancellationToken);
    }

    private static async Task<T> ReadResponseAsync<T>(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (!response.IsSuccessStatusCode)
        {
            var payload = await response.Content.ReadAsStringAsync(cancellationToken);
            string message;
            try { message = JsonDocument.Parse(payload).RootElement.GetProperty("error").GetString() ?? payload; }
            catch { message = payload; }
            throw new InvalidOperationException(string.IsNullOrWhiteSpace(message) ? $"Local engine returned {(int)response.StatusCode}." : message);
        }
        var result = await response.Content.ReadFromJsonAsync<T>(JsonDefaults.Options, cancellationToken);
        return result ?? throw new InvalidOperationException("The local capture engine returned an empty response.");
    }

    public void Dispose() => _client.Dispose();
}

public sealed class ClipListEnvelope
{
    public List<ClipEntry> Clips { get; set; } = [];
}

public sealed class ClipSaveEnvelope
{
    public ClipEntry? Clip { get; set; }
}
