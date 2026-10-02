using System.Diagnostics;
using System.IO.Pipes;
using System.Buffers.Binary;
using System.Text.Json;

namespace Spool.App;

public sealed class DiscordPresenceClient : IAsyncDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private NamedPipeClientStream? _pipe;
    private string? _clientId;

    public async Task<string?> UpdateAsync(AppSettings settings, string? game, EngineSnapshot engine, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var applicationId = settings.DiscordApplicationId.Trim();
            if (!settings.DiscordPresenceEnabled || applicationId.Length == 0)
            {
                if (_pipe?.IsConnected == true) await SendActivityAsync(null, cancellationToken);
                await DisconnectAsync();
                return null;
            }

            if (_clientId != applicationId) await DisconnectAsync();
            await EnsureConnectedAsync(applicationId, cancellationToken);
            var running = string.Equals(engine.State, "running", StringComparison.OrdinalIgnoreCase);
            var activity = new Dictionary<string, object?>
            {
                ["details"] = game is null ? "Instant replay" : game,
                ["state"] = !running ? "Replay paused" : engine.BufferReady ? $"Replay ready · {engine.Config.ReplayLength}s" : $"Buffering · {engine.BufferSeconds}s"
            };
            await SendActivityAsync(activity, cancellationToken);
            return "Discord Rich Presence is connected.";
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception exception)
        {
            await DisconnectAsync();
            return exception.Message;
        }
        finally { _gate.Release(); }
    }

    public async ValueTask DisposeAsync()
    {
        await _gate.WaitAsync();
        try
        {
            if (_pipe?.IsConnected == true)
            {
                try { await SendActivityAsync(null, CancellationToken.None); }
                catch { }
            }
            await DisconnectAsync();
        }
        finally
        {
            _gate.Release();
            _gate.Dispose();
        }
    }

    private async Task EnsureConnectedAsync(string applicationId, CancellationToken cancellationToken)
    {
        if (_pipe?.IsConnected == true && _clientId == applicationId) return;
        await DisconnectAsync();
        Exception? lastException = null;
        for (var index = 0; index < 10; index++)
        {
            var candidate = new NamedPipeClientStream(".", $"discord-ipc-{index}", PipeDirection.InOut, PipeOptions.Asynchronous);
            try
            {
                await candidate.ConnectAsync(350, cancellationToken);
                _pipe = candidate;
                _clientId = applicationId;
                await WriteFrameAsync(0, JsonSerializer.SerializeToUtf8Bytes(new { v = 1, client_id = applicationId }), cancellationToken);
                using var handshakeTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                handshakeTimeout.CancelAfter(TimeSpan.FromSeconds(2));
                var ready = await ReadMessageAsync(handshakeTimeout.Token);
                if (!ready.TryGetProperty("evt", out var eventName) || eventName.GetString() != "READY")
                    throw new InvalidOperationException("Discord did not complete the RPC handshake.");
                return;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                lastException = new TimeoutException("Discord did not respond to the RPC handshake.");
                candidate.Dispose();
                _pipe = null;
            }
            catch (Exception exception)
            {
                lastException = exception;
                candidate.Dispose();
                _pipe = null;
            }
        }
        throw new InvalidOperationException(lastException is TimeoutException ? "Discord is open but did not answer its local RPC pipe." : "Open Discord desktop and check its Rich Presence settings.", lastException);
    }

    private async Task SendActivityAsync(object? activity, CancellationToken cancellationToken)
    {
        if (_pipe?.IsConnected != true || _clientId is null) return;
        var args = new Dictionary<string, object?> { ["pid"] = Environment.ProcessId, ["activity"] = activity };
        var payload = JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object?>
        {
            ["cmd"] = "SET_ACTIVITY",
            ["args"] = args,
            ["nonce"] = Guid.NewGuid().ToString("N")
        });
        await WriteFrameAsync(1, payload, cancellationToken);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(2));
        var response = await ReadMessageAsync(timeout.Token);
        if (response.TryGetProperty("evt", out var errorEvent) && errorEvent.GetString() == "ERROR")
        {
            var message = response.TryGetProperty("data", out var data) && data.TryGetProperty("message", out var text) ? text.GetString() : null;
            throw new InvalidOperationException(message ?? "Discord rejected the Rich Presence update.");
        }
    }

    private async Task WriteFrameAsync(int opcode, byte[] payload, CancellationToken cancellationToken)
    {
        if (_pipe is null) throw new IOException("Discord RPC is disconnected.");
        var header = new byte[8];
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(0, 4), opcode);
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(4, 4), payload.Length);
        await _pipe.WriteAsync(header, cancellationToken);
        await _pipe.WriteAsync(payload, cancellationToken);
        await _pipe.FlushAsync(cancellationToken);
    }

    private async Task<JsonElement> ReadMessageAsync(CancellationToken cancellationToken)
    {
        if (_pipe is null) throw new IOException("Discord RPC is disconnected.");
        var header = new byte[8];
        await _pipe.ReadExactlyAsync(header, cancellationToken);
        var opcode = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(0, 4));
        var length = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(4, 4));
        if (length is < 0 or > 1024 * 1024) throw new InvalidDataException("Discord RPC returned an invalid frame size.");
        var body = new byte[length];
        await _pipe.ReadExactlyAsync(body, cancellationToken);
        using var document = JsonDocument.Parse(body);
        if (opcode == 2) throw new InvalidOperationException("Discord rejected the local RPC handshake.");
        return document.RootElement.Clone();
    }

    private async Task DisconnectAsync()
    {
        if (_pipe is not null)
        {
            await _pipe.DisposeAsync();
            _pipe = null;
            _clientId = null;
        }
    }
}
