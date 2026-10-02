using NetMQ;
using NetMQ.Sockets;

namespace Spool.App;

public static class FfmpegCommandClient
{
    public static Task SendMicrophoneGainAsync(int port, int volumePercent, CancellationToken cancellationToken = default)
    {
        if (port is < 1024 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        var command = $"spool_mic volume {Math.Clamp(volumePercent, 0, 125) / 100d:0.##}";
        return Task.Run(() =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            using var socket = new RequestSocket();
            socket.Options.Linger = TimeSpan.Zero;
            socket.Connect($"tcp://127.0.0.1:{port}");
            if (!socket.TrySendFrame(TimeSpan.FromMilliseconds(350), command))
                throw new TimeoutException("FFmpeg did not accept the microphone command.");
            if (!socket.TryReceiveFrameString(TimeSpan.FromMilliseconds(900), out var reply))
                throw new TimeoutException("FFmpeg did not confirm the microphone command.");
            if (!reply.StartsWith("0", StringComparison.Ordinal))
                throw new InvalidOperationException($"FFmpeg rejected the microphone command: {reply}");
        }, cancellationToken);
    }
}
