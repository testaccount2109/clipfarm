using System.Windows;

namespace Spool.App;

public partial class App : System.Windows.Application
{
    private EngineHost? _engineHost;

    private async void Application_Startup(object sender, StartupEventArgs e)
    {
        var splash = new SplashWindow();
        splash.Show();
        try
        {
            var settings = AppSettings.Load();
            _engineHost = new EngineHost();
            splash.SetStatus("Starting the local capture service…");
            await _engineHost.StartAsync();

            var api = new EngineClient(_engineHost.BaseAddress);
            string? startupError = null;
            var previewMode = e.Args.Contains("--ui-preview", StringComparer.OrdinalIgnoreCase);
            if (previewMode)
            {
                startupError = "Preview mode keeps the capture engine paused.";
            }
            else if (settings.StartReplayOnLaunch)
            {
                splash.SetStatus("Preparing the replay buffer…");
                try { await api.StartEngineAsync(); }
                catch (Exception exception) { startupError = exception.Message; }
            }

            var window = new MainWindow(api, _engineHost, settings, startupError);
            MainWindow = window;
            window.Show();
            splash.Close();
        }
        catch (Exception exception)
        {
            splash.Close();
            MessageBox.Show($"Spool could not start its local capture service.\n\n{exception.Message}", "Spool", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(-1);
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _engineHost?.Dispose();
        base.OnExit(e);
    }
}
