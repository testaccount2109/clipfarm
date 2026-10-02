using System.Diagnostics;
using System.Net;
using System.Net.Sockets;

namespace Spool.App;

public sealed class EngineHost : IDisposable
{
    private Process? _process;
    private readonly int _port = FindAvailablePort();
    private readonly int _audioPort = FindAvailablePort();

    public Uri BaseAddress => new($"http://127.0.0.1:{_port}/");
    public int AudioControlPort => _audioPort;
    public int? ProcessId => _process is { HasExited: false } ? _process.Id : null;

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_process is { HasExited: false }) return;
        var engineDirectory = FindEngineDirectory();
        var serverPath = Path.Combine(engineDirectory, "server.js");
        if (!File.Exists(serverPath)) throw new FileNotFoundException("Spool's capture host was not installed.", serverPath);

        var dataDirectory = AppSettings.DataDirectory;
        var clipDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "Spool");
        var bufferDirectory = Path.Combine(Path.GetTempPath(), "Spool-buffer");
        Directory.CreateDirectory(dataDirectory);
        Directory.CreateDirectory(clipDirectory);
        Directory.CreateDirectory(bufferDirectory);

        var nodePath = Environment.GetEnvironmentVariable("SPOOL_NODE_PATH");
        if (string.IsNullOrWhiteSpace(nodePath) || !File.Exists(nodePath))
        {
            var bundledNode = Path.Combine(engineDirectory, "node.exe");
            nodePath = File.Exists(bundledNode) ? bundledNode : "node.exe";
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = engineDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.ArgumentList.Add(serverPath);
        startInfo.Environment["CLIPFARM_PORT"] = _port.ToString();
        startInfo.Environment["CLIPFARM_AUDIO_CONTROL_PORT"] = _audioPort.ToString();
        startInfo.Environment["SPOOL_DATA_DIR"] = dataDirectory;
        startInfo.Environment["CLIPFARM_CLIPS"] = clipDirectory;
        startInfo.Environment["CLIPFARM_BUFFER"] = bufferDirectory;
        startInfo.Environment["SPOOL_PRODUCT_NAME"] = "Spool";
        var bundledFfmpeg = Path.Combine(engineDirectory, "tools", "ffmpeg.exe");
        if (File.Exists(bundledFfmpeg)) startInfo.Environment["CLIPFARM_FFMPEG"] = bundledFfmpeg;

        _process = Process.Start(startInfo) ?? throw new InvalidOperationException("Windows did not start Spool's capture host.");
        _process.OutputDataReceived += (_, args) => WriteEngineLog(args.Data);
        _process.ErrorDataReceived += (_, args) => WriteEngineLog(args.Data);
        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(1) };
        for (var attempt = 0; attempt < 40; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_process.HasExited) throw new InvalidOperationException($"Spool's capture host exited ({_process.ExitCode}). Check {Path.Combine(dataDirectory, "logs", "engine.log")}.");
            try
            {
                using var response = await client.GetAsync(new Uri(BaseAddress, "api/health"), cancellationToken);
                if (response.IsSuccessStatusCode) return;
            }
            catch (HttpRequestException) { }
            catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { }
            await Task.Delay(250, cancellationToken);
        }
        throw new TimeoutException("Spool's local capture host did not respond in time.");
    }

    public async Task StopAsync()
    {
        if (_process is not { HasExited: false }) return;
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
            using var body = new StringContent("{}", System.Text.Encoding.UTF8, "application/json");
            await client.PostAsync(new Uri(BaseAddress, "api/engine/stop"), body);
        }
        catch { }
        try
        {
            if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
            if (_process is not null) await _process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(3));
        }
        catch { }
    }

    public void Dispose()
    {
        try
        {
            if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
        }
        catch { }
        _process?.Dispose();
    }

    private static string FindEngineDirectory()
    {
        var outputEngine = Path.Combine(AppContext.BaseDirectory, "Engine");
        if (File.Exists(Path.Combine(outputEngine, "server.js"))) return outputEngine;
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "server.js"))) return directory.FullName;
        }
        return outputEngine;
    }

    private static int FindAvailablePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static void WriteEngineLog(string? message)
    {
        if (string.IsNullOrWhiteSpace(message)) return;
        try
        {
            var directory = Path.Combine(AppSettings.DataDirectory, "logs");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "engine.log"), $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch { }
    }
}
