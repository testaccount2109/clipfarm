using System.Diagnostics;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using Microsoft.Win32;
using Forms = System.Windows.Forms;
using ComboBox = System.Windows.Controls.ComboBox;

namespace Spool.App;

public partial class MainWindow : Window
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private readonly EngineClient _api;
    private readonly EngineHost _host;
    private readonly AppSettings _appSettings;
    private readonly Forms.NotifyIcon _trayIcon;
    private readonly Forms.ContextMenuStrip _trayMenu;
    private readonly DispatcherTimer _pollTimer;
    private readonly DispatcherTimer _toastTimer;
    private readonly DiscordPresenceClient _discord = new();
    private GlobalHotkeyManager? _hotkeys;
    private EngineSnapshot _engine = new();
    private SessionSnapshot _session = new();
    private EngineConfig _config = new();
    private MetricsSnapshot _metrics = new();
    private List<ClipEntry> _clips = [];
    private string? _startupError;
    private string? _hotkeyCaptureName;
    private bool _isRefreshing;
    private bool _allowExit;
    private bool _micActionInFlight;
    private string? _lastPresenceFingerprint;
    private DateTimeOffset _lastPresenceSentAt = DateTimeOffset.MinValue;
    private TimeSpan _lastUiCpuTime;
    private DateTimeOffset _lastUiCpuAt = DateTimeOffset.UtcNow;
    private double _uiCpuPercent;

    public MainWindow(EngineClient api, EngineHost host, AppSettings appSettings, string? startupError)
    {
        InitializeComponent();
        _api = api;
        _host = host;
        _appSettings = appSettings;
        _startupError = startupError;

        PopulateSettingsCombos();
        _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        _pollTimer.Tick += async (_, _) => await RefreshSnapshotAsync();
        _toastTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2.8) };
        _toastTimer.Tick += (_, _) => { ToastSurface.Visibility = Visibility.Collapsed; _toastTimer.Stop(); };
        _trayMenu = BuildTrayMenu();
        _trayIcon = CreateTrayIcon();

        SourceInitialized += MainWindow_SourceInitialized;
        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;
        IsVisibleChanged += (_, _) => _pollTimer.Interval = IsVisible ? TimeSpan.FromSeconds(3) : TimeSpan.FromSeconds(12);
        StateChanged += (_, _) => { if (WindowState == WindowState.Minimized) Hide(); };
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            var configEnvelope = await _api.GetConfigAsync();
            _config = configEnvelope.Config;
            _engine = configEnvelope.Engine;
            PopulateConfigControls();
            if (_hotkeys is not null) RegisterHotkeys();
            await LoadAudioDevicesAsync();
            await LoadClipsAsync();
            await RefreshSnapshotAsync();
            _pollTimer.Start();
            if (_startupError is not null) ShowToast($"Replay could not start: {_startupError}");
            if (_appSettings.DiscordPresenceEnabled && string.IsNullOrWhiteSpace(_appSettings.DiscordApplicationId))
                DiscordStatusText.Text = "Add a Discord application ID to connect Rich Presence.";
            UpdateLoginOptionFromRegistry();
        }
        catch (Exception exception)
        {
            TitleStatus.Text = "Capture service disconnected";
            SetEngineStatus(false, "OFFLINE");
            ShowToast(exception.Message);
        }
    }

    private void MainWindow_SourceInitialized(object? sender, EventArgs e)
    {
        _hotkeys = new GlobalHotkeyManager(this);
        _hotkeys.Pressed += Hotkeys_Pressed;
        if (_config.Hotkeys.Count > 0) RegisterHotkeys();
    }

    private async Task LoadAudioDevicesAsync()
    {
        try
        {
            var audio = await _api.GetAudioDevicesAsync();
            MicrophoneCombo.Items.Clear();
            if (audio.Devices.Count == 0)
            {
                MicrophoneCombo.Items.Add(new ComboBoxItem { Content = "No DirectShow microphone found", Tag = "" });
                MicrophoneCombo.SelectedIndex = 0;
                MicSettingHelp.Text = "No microphone source was found. Replay can run without audio.";
                return;
            }
            foreach (var device in audio.Devices)
                MicrophoneCombo.Items.Add(new ComboBoxItem { Content = device, Tag = device });
            SelectComboValue(MicrophoneCombo, _config.MicrophoneDevice ?? audio.Selected ?? audio.Devices[0]);
        }
        catch
        {
            MicrophoneCombo.Items.Clear();
            MicrophoneCombo.Items.Add(new ComboBoxItem { Content = "Could not read audio devices", Tag = "" });
            MicrophoneCombo.SelectedIndex = 0;
        }
    }

    private async Task RefreshSnapshotAsync()
    {
        if (_isRefreshing) return;
        _isRefreshing = true;
        try
        {
            var engineTask = _api.GetEngineAsync();
            var sessionTask = _api.GetSessionAsync();
            var metricsTask = _api.GetMetricsAsync();
            await Task.WhenAll(engineTask, sessionTask, metricsTask);
            _engine = await engineTask;
            _session = await sessionTask;
            _metrics = await metricsTask;
            _config = _engine.Config;
            UpdateReplayView();
            UpdateMetricsView();
            UpdateSessionView();
            await UpdateDiscordPresenceIfNeededAsync();
        }
        catch (Exception exception)
        {
            TitleStatus.Text = "Capture service disconnected";
            SetEngineStatus(false, "OFFLINE");
            if (IsVisible) ShowToast(exception.Message);
        }
        finally { _isRefreshing = false; }
    }

    private void UpdateReplayView()
    {
        var running = string.Equals(_engine.State, "running", StringComparison.OrdinalIgnoreCase);
        SetEngineStatus(running, running ? "REPLAY ON" : _engine.State.ToUpperInvariant());
        ReplayDot.Fill = running ? (SolidColorBrush)FindResource("Green") : (SolidColorBrush)FindResource("TextMuted");
        ReplayStatusText.Text = running ? (_engine.BufferReady ? "BUFFER READY" : "BUFFERING") : "PAUSED";
        ReplayStatusText.Foreground = running ? (SolidColorBrush)FindResource("Green") : (SolidColorBrush)FindResource("TextSecondary");
        BufferStateText.Text = running ? (_engine.BufferReady ? "READY" : "FILLING") : "WAITING";
        ReplayStateText.Text = running ? (_engine.BufferReady ? "Replay is ready" : "Building buffer") : "Replay paused";
        BufferDetailText.Text = running
            ? (_engine.BufferReady ? "The selected replay length is buffered." : $"Buffer building · {_engine.BufferSeconds} / {_config.ReplayLength} sec")
            : "Start replay to begin buffering.";
        ReplayLengthText.Text = _config.ReplayLength.ToString(CultureInfo.InvariantCulture);
        SaveLengthLabel.Text = $"{_config.ReplayLength} SEC";
        SaveHotkeyBadge.Text = GetHotkey("save", "F8");
        BufferProgress.Value = _config.ReplayLength == 0 ? 0 : Math.Clamp(_engine.BufferSeconds * 100d / _config.ReplayLength, 0, 100);
        SaveClipButton.IsEnabled = running && _engine.BufferReady;
        ToggleReplayButton.Content = running ? "Pause replay" : "Start replay";
        MicToggleSetting.Content = _engine.MicEnabled ? "On" : "Off";
        MicToggleSetting.Foreground = _engine.MicEnabled ? (SolidColorBrush)FindResource("Green") : (SolidColorBrush)FindResource("TextSecondary");
        TitleStatus.Text = running ? "Capture engine is running locally" : "Capture engine is paused";
        if (!string.IsNullOrWhiteSpace(_engine.Error)) TitleStatus.Text = _engine.Error;
    }

    private void UpdateMetricsView()
    {
        var process = Process.GetCurrentProcess();
        var now = DateTimeOffset.UtcNow;
        var cpuTime = process.TotalProcessorTime;
        var elapsed = Math.Max(0.05, (now - _lastUiCpuAt).TotalSeconds);
        _uiCpuPercent = Math.Max(0, (cpuTime - _lastUiCpuTime).TotalSeconds / elapsed / Math.Max(1, Environment.ProcessorCount) * 100);
        _lastUiCpuAt = now;
        _lastUiCpuTime = cpuTime;

        var cpu = (_metrics.CpuPercent ?? 0) + _uiCpuPercent;
        var memoryBytes = (_metrics.RamBytes ?? 0) + process.WorkingSet64;
        CpuMetricText.Text = _metrics.CpuPercent is null ? "n/a" : $"{cpu:0.0}%";
        MemoryMetricText.Text = $"{memoryBytes / 1024d / 1024d:0} MB";
        GpuMetricText.Text = _metrics.GpuAvailable && _metrics.GpuPercent is not null ? $"{_metrics.GpuPercent:0.0}%" : "n/a";
    }

    private void UpdateSessionView()
    {
        var hasGame = !string.IsNullOrWhiteSpace(_session.Game);
        GameNameText.Text = hasGame ? _session.Game! : "No game detected";
        var capture = _engine.CaptureMethod ?? _session.CaptureMethod ?? "display";
        CaptureTargetText.Text = capture switch
        {
            "game" => "Game window capture",
            "window" => "Window capture",
            "display" => "Display capture",
            _ => "Waiting for capture target"
        };
        ResolutionText.Text = _config.Resolution.Replace("x", " × ", StringComparison.Ordinal);
        FpsText.Text = $"{_config.Fps} FPS";
        EncoderText.Text = _config.Encoder == "h264_amf" ? "AMD AMF AVC" : "AMD AMF HEVC";
    }

    private async Task UpdateDiscordPresenceIfNeededAsync()
    {
        if (!_appSettings.DiscordPresenceEnabled)
        {
            if (_lastPresenceFingerprint is not null) await _discord.UpdateAsync(_appSettings, _session.Game, _engine);
            _lastPresenceFingerprint = null;
            return;
        }
        if (string.IsNullOrWhiteSpace(_appSettings.DiscordApplicationId))
        {
            if (SettingsPage.Visibility == Visibility.Visible) DiscordStatusText.Text = "Add a Discord application ID to connect Rich Presence.";
            return;
        }
        var fingerprint = $"{_session.Game}|{_engine.State}|{_engine.BufferReady}|{_config.ReplayLength}";
        if (fingerprint == _lastPresenceFingerprint && DateTimeOffset.UtcNow - _lastPresenceSentAt < TimeSpan.FromSeconds(30)) return;
        _lastPresenceFingerprint = fingerprint;
        _lastPresenceSentAt = DateTimeOffset.UtcNow;
        var status = await _discord.UpdateAsync(_appSettings, _session.Game, _engine);
        if (SettingsPage.Visibility == Visibility.Visible && status is not null) DiscordStatusText.Text = status;
    }

    private async void SaveClip_Click(object sender, RoutedEventArgs e) => await SaveClipAsync();

    private async Task SaveClipAsync()
    {
        if (!_engine.BufferReady)
        {
            ShowToast(_engine.State == "running" ? "Wait for the replay buffer to fill." : "Start replay before saving a clip.");
            return;
        }
        try
        {
            var clip = await _api.SaveClipAsync(_config.ReplayLength, _session.Game ?? "Game");
            ShowToast(clip is null ? "Clip saved." : $"Clip saved · {Path.GetFileName(clip.File)}");
            await LoadClipsAsync();
        }
        catch (Exception exception) { ShowToast(exception.Message); }
    }

    private async void ToggleReplay_Click(object sender, RoutedEventArgs e) => await ToggleReplayAsync();

    private async Task ToggleReplayAsync()
    {
        try
        {
            _engine = string.Equals(_engine.State, "running", StringComparison.OrdinalIgnoreCase)
                ? await _api.StopEngineAsync()
                : await _api.StartEngineAsync();
            UpdateReplayView();
            ShowToast(_engine.State == "running" ? "Instant replay started." : "Instant replay paused.");
        }
        catch (Exception exception) { ShowToast(exception.Message); }
    }

    private async void Mic_Click(object sender, RoutedEventArgs e) => await ToggleMicrophoneAsync();

    private async Task ToggleMicrophoneAsync()
    {
        if (_micActionInFlight) return;
        _micActionInFlight = true;
        var next = !_engine.MicEnabled;
        try
        {
            var hasLiveMicStream = _engine.State == "running" && !string.IsNullOrWhiteSpace(_engine.AudioSource) && _engine.AudioSource != "none";
            if (hasLiveMicStream)
                await FfmpegCommandClient.SendMicrophoneGainAsync(_host.AudioControlPort, next ? _config.MicrophoneVolume : 0);
            await _api.SetMicrophoneAsync(next);
            _engine.MicEnabled = next;
            UpdateReplayView();
            ShowToast(next ? "Microphone enabled." : "Microphone muted.");
        }
        catch (Exception exception) { ShowToast(exception.Message); }
        finally { _micActionInFlight = false; }
    }

    private async Task LoadClipsAsync()
    {
        try
        {
            _clips = (await _api.GetClipsAsync()).OrderByDescending(clip => clip.SavedAt).ToList();
            ClipCountText.Text = _clips.Count == 1 ? "1 clip saved on this PC" : $"{_clips.Count} clips saved on this PC";
            RecentClipsList.ItemsSource = _clips.Take(3).ToList();
            ApplyClipSearch();
        }
        catch (Exception exception) { LibraryStatusText.Text = exception.Message; }
    }

    private void ApplyClipSearch()
    {
        var query = ClipSearchBox.Text.Trim();
        var filtered = string.IsNullOrEmpty(query)
            ? _clips
            : _clips.Where(clip => clip.Name.Contains(query, StringComparison.OrdinalIgnoreCase) || clip.Game.Contains(query, StringComparison.OrdinalIgnoreCase)).ToList();
        ClipsList.ItemsSource = filtered;
        LibraryStatusText.Text = filtered.Count == _clips.Count ? "" : $"{filtered.Count} matches";
    }

    private void PopulateSettingsCombos()
    {
        FillCombo(ReplayLengthCombo, ("15 seconds", "15"), ("30 seconds", "30"), ("60 seconds", "60"), ("120 seconds", "120"));
        FillCombo(ResolutionCombo, ("1920 × 1080", "1920x1080"), ("2560 × 1440", "2560x1440"), ("3840 × 2160", "3840x2160"));
        FillCombo(FpsCombo, ("60 FPS", "60"), ("120 FPS", "120"));
        FillCombo(BitrateCombo, ("18 Mbps", "18M"), ("28 Mbps", "28M"), ("45 Mbps", "45M"));
        FillCombo(EncoderCombo, ("AMD AMF HEVC", "hevc_amf"), ("AMD AMF AVC", "h264_amf"));
        FillCombo(QualityCombo, ("Performance", "performance"), ("Balanced", "balanced"), ("Quality", "quality"));
        FillCombo(MicrophoneVolumeCombo, ("25%", "25"), ("50%", "50"), ("75%", "75"), ("100%", "100"), ("125%", "125"));
        FillCombo(MaxStorageCombo, ("10 GB", "10"), ("50 GB", "50"), ("100 GB", "100"));
        FillCombo(CaptureMethodCombo, ("Auto · game then display", "auto"), ("Game window", "game"), ("Window", "window"), ("Display", "display"));
    }

    private void PopulateConfigControls()
    {
        SelectComboValue(ReplayLengthCombo, _config.ReplayLength.ToString(CultureInfo.InvariantCulture));
        SelectComboValue(ResolutionCombo, _config.Resolution);
        SelectComboValue(FpsCombo, _config.Fps.ToString(CultureInfo.InvariantCulture));
        SelectComboValue(BitrateCombo, _config.Bitrate);
        SelectComboValue(EncoderCombo, _config.Encoder);
        SelectComboValue(QualityCombo, _config.Quality);
        SelectComboValue(MicrophoneVolumeCombo, _config.MicrophoneVolume.ToString(CultureInfo.InvariantCulture));
        SelectComboValue(MaxStorageCombo, _config.MaxStorageGb.ToString(CultureInfo.InvariantCulture));
        SelectComboValue(CaptureMethodCombo, _config.CaptureMethod);
        ClipFolderText.Text = _config.ClipDirectory;
        BackgroundPriorityCheck.IsChecked = _config.BackgroundPriority;
        AutoStartCheck.IsChecked = _appSettings.StartReplayOnLaunch;
        DiscordEnabledCheck.IsChecked = _appSettings.DiscordPresenceEnabled;
        DiscordClientIdText.Text = _appSettings.DiscordApplicationId;
        UpdateHotkeyButtons();
    }

    private async void SaveSettings_Click(object sender, RoutedEventArgs e)
    {
        var hotkeys = new Dictionary<string, string>(_config.Hotkeys, StringComparer.OrdinalIgnoreCase);
        if (_pendingHotkeys.Count > 0)
            foreach (var pair in _pendingHotkeys) hotkeys[pair.Key] = pair.Value;
        var patch = new Dictionary<string, object?>
        {
            ["replayLength"] = ReadIntCombo(ReplayLengthCombo, 30),
            ["resolution"] = ReadStringCombo(ResolutionCombo, "1920x1080"),
            ["fps"] = ReadIntCombo(FpsCombo, 60),
            ["bitrate"] = ReadStringCombo(BitrateCombo, "28M"),
            ["encoder"] = ReadStringCombo(EncoderCombo, "hevc_amf"),
            ["quality"] = ReadStringCombo(QualityCombo, "balanced"),
            ["captureMethod"] = ReadStringCombo(CaptureMethodCombo, "auto"),
            ["microphoneDevice"] = ReadStringCombo(MicrophoneCombo, "") is { Length: > 0 } device ? device : null,
            ["microphoneVolume"] = ReadIntCombo(MicrophoneVolumeCombo, 100),
            ["clipDirectory"] = string.IsNullOrWhiteSpace(ClipFolderText.Text) ? _config.ClipDirectory : ClipFolderText.Text.Trim(),
            ["maxStorageGb"] = ReadIntCombo(MaxStorageCombo, 50),
            ["backgroundPriority"] = BackgroundPriorityCheck.IsChecked == true,
            ["hotkeys"] = hotkeys
        };
        try
        {
            SettingsSaveStatus.Text = "Saving…";
            var result = await _api.UpdateConfigAsync(patch);
            _config = result.Config;
            _engine = result.Engine;
            _pendingHotkeys.Clear();
            RegisterHotkeys();
            _appSettings.StartReplayOnLaunch = AutoStartCheck.IsChecked == true;
            _appSettings.LaunchAtLogin = LaunchAtLoginCheck.IsChecked == true;
            _appSettings.DiscordPresenceEnabled = DiscordEnabledCheck.IsChecked == true;
            _appSettings.DiscordApplicationId = DiscordClientIdText.Text.Trim();
            _appSettings.Save();
            SetLaunchAtLogin(_appSettings.LaunchAtLogin);
            _lastPresenceFingerprint = null;
            SettingsSaveStatus.Text = "Saved";
            SettingsSaveStatus.Foreground = (SolidColorBrush)FindResource("Green");
            UpdateReplayView();
            UpdateSessionView();
            await LoadClipsAsync();
            await UpdateDiscordPresenceIfNeededAsync();
            ShowToast("Settings saved.");
        }
        catch (Exception exception)
        {
            SettingsSaveStatus.Text = "Could not save";
            SettingsSaveStatus.Foreground = new SolidColorBrush(Color.FromRgb(220, 130, 115));
            ShowToast(exception.Message);
        }
    }

    private readonly Dictionary<string, string> _pendingHotkeys = new(StringComparer.OrdinalIgnoreCase);

    private void CaptureHotkey_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button button || button.Tag is not string name) return;
        _hotkeyCaptureName = name;
        button.Content = "Press a key…";
        SettingsSaveStatus.Text = "Press a key combination, then save settings.";
        Focus();
    }

    private void Window_PreviewKeyDown(object sender, System.Windows.Input.KeyEventArgs e)
    {
        if (_hotkeyCaptureName is null) return;
        e.Handled = true;
        var key = e.Key == Key.System ? e.SystemKey : e.Key;
        if (key == Key.Escape)
        {
            _hotkeyCaptureName = null;
            UpdateHotkeyButtons();
            return;
        }
        if (key is Key.LeftCtrl or Key.RightCtrl or Key.LeftAlt or Key.RightAlt or Key.LeftShift or Key.RightShift or Key.LWin or Key.RWin) return;
        var parts = new List<string>();
        var modifiers = Keyboard.Modifiers;
        if (modifiers.HasFlag(ModifierKeys.Control)) parts.Add("CTRL");
        if (modifiers.HasFlag(ModifierKeys.Alt)) parts.Add("ALT");
        if (modifiers.HasFlag(ModifierKeys.Shift)) parts.Add("SHIFT");
        if (modifiers.HasFlag(ModifierKeys.Windows)) parts.Add("WIN");
        parts.Add(key.ToString().ToUpperInvariant());
        var specification = string.Join('+', parts);
        if (!System.Text.RegularExpressions.Regex.IsMatch(specification, "^(?:(?:CTRL|ALT|SHIFT|WIN)\\+){0,3}(?:F(?:[1-9]|1[0-2])|[A-Z]|[0-9])$"))
        {
            ShowToast("Choose F1–F12, a letter or a number, optionally with modifiers.");
            return;
        }
        _pendingHotkeys[_hotkeyCaptureName] = specification;
        _hotkeyCaptureName = null;
        UpdateHotkeyButtons();
        SettingsSaveStatus.Text = "Hotkey changed locally. Save settings to apply it.";
    }

    private void UpdateHotkeyButtons()
    {
        SaveHotkeyButton.Content = $"{GetHotkey("save", "F8")} · Change";
        ToggleHotkeyButton.Content = $"{GetHotkey("toggle", "F9")} · Change";
        MicHotkeyButton.Content = $"{GetHotkey("microphone", "F10")} · Change";
    }

    private void RegisterHotkeys()
    {
        if (_hotkeys is null || _config.Hotkeys.Count == 0) return;
        var errors = _hotkeys.Register(_config.Hotkeys);
        if (errors.Count > 0) ShowToast($"Windows could not register: {string.Join(", ", errors)}");
    }

    private async void Hotkeys_Pressed(string action)
    {
        switch (action)
        {
            case "save": await SaveClipAsync(); break;
            case "toggle": await ToggleReplayAsync(); break;
            case "microphone": await ToggleMicrophoneAsync(); break;
        }
    }

    private async void ClipSearch_TextChanged(object sender, TextChangedEventArgs e) => ApplyClipSearch();
    private async void OpenClip_Click(object sender, RoutedEventArgs e) => await OpenClipAsync(sender);
    private async void PlayClip_Click(object sender, RoutedEventArgs e) => await OpenClipAsync(sender);
    private async void RevealClip_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string file }) return;
        try { await _api.FileActionAsync("open", file, action: "reveal"); }
        catch (Exception exception) { ShowToast(exception.Message); }
    }

    private async Task OpenClipAsync(object sender)
    {
        if (sender is not Button { Tag: string file }) return;
        try { Process.Start(new ProcessStartInfo(file) { UseShellExecute = true }); }
        catch (Exception exception) { ShowToast(exception.Message); }
        await Task.CompletedTask;
    }

    private async void RenameClip_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string file }) return;
        var current = Path.GetFileNameWithoutExtension(file);
        var next = Microsoft.VisualBasic.Interaction.InputBox("Enter a new clip name.", "Rename clip", current).Trim();
        if (string.IsNullOrWhiteSpace(next) || next == current) return;
        try
        {
            await _api.FileActionAsync("rename", file, next);
            await LoadClipsAsync();
            ShowToast("Clip renamed.");
        }
        catch (Exception exception) { ShowToast(exception.Message); }
    }

    private async void DeleteClip_Click(object sender, RoutedEventArgs e)
    {
        if (sender is not Button { Tag: string file }) return;
        var result = MessageBox.Show($"Delete {Path.GetFileName(file)}? This removes the local clip file.", "Delete clip", MessageBoxButton.YesNo, MessageBoxImage.Warning);
        if (result != MessageBoxResult.Yes) return;
        try
        {
            await _api.FileActionAsync("delete", file);
            await LoadClipsAsync();
            ShowToast("Clip deleted.");
        }
        catch (Exception exception) { ShowToast(exception.Message); }
    }

    private void OpenClipFolder_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(_config.ClipDirectory);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{_config.ClipDirectory}\"") { UseShellExecute = true });
        }
        catch (Exception exception) { ShowToast(exception.Message); }
    }

    private void BrowseClipFolder_Click(object sender, RoutedEventArgs e)
    {
        using var dialog = new Forms.FolderBrowserDialog { SelectedPath = ClipFolderText.Text, ShowNewFolderButton = true, Description = "Choose where Spool saves clips" };
        if (dialog.ShowDialog() == Forms.DialogResult.OK) ClipFolderText.Text = dialog.SelectedPath;
    }

    private void ReplayNav_Click(object sender, RoutedEventArgs e) => SetPage(ReplayPage, ReplayMark);
    private async void ClipsNav_Click(object sender, RoutedEventArgs e) { SetPage(ClipsPage, ClipsMark); await LoadClipsAsync(); }
    private void SettingsNav_Click(object sender, RoutedEventArgs e) => SetPage(SettingsPage, SettingsMark);

    private void SetPage(Grid page, Border mark)
    {
        ReplayPage.Visibility = Visibility.Collapsed;
        ClipsPage.Visibility = Visibility.Collapsed;
        SettingsPage.Visibility = Visibility.Collapsed;
        ReplayMark.Background = Brushes.Transparent;
        ClipsMark.Background = Brushes.Transparent;
        SettingsMark.Background = Brushes.Transparent;
        page.Visibility = Visibility.Visible;
        page.Opacity = 0.82;
        page.BeginAnimation(OpacityProperty, new DoubleAnimation(1, TimeSpan.FromMilliseconds(140)) { EasingFunction = new QuadraticEase { EasingMode = EasingMode.EaseOut } });
        mark.Background = (SolidColorBrush)FindResource("Accent");
    }

    private void SetEngineStatus(bool running, string label)
    {
        EngineStateLabel.Text = label;
        EngineDot.Fill = running ? (SolidColorBrush)FindResource("Green") : (SolidColorBrush)FindResource("TextMuted");
    }

    private void ShowToast(string message)
    {
        ToastText.Text = message;
        ToastSurface.Visibility = Visibility.Visible;
        _toastTimer.Stop();
        _toastTimer.Start();
    }

    private string GetHotkey(string name, string fallback) =>
        _pendingHotkeys.TryGetValue(name, out var pending) ? pending : _config.Hotkeys.TryGetValue(name, out var value) ? value : fallback;

    private static void FillCombo(ComboBox combo, params (string Label, string Value)[] options)
    {
        foreach (var option in options) combo.Items.Add(new ComboBoxItem { Content = option.Label, Tag = option.Value });
        if (combo.Items.Count > 0) combo.SelectedIndex = 0;
    }

    private static void SelectComboValue(ComboBox combo, string? value)
    {
        foreach (var item in combo.Items.OfType<ComboBoxItem>())
        {
            if (string.Equals(item.Tag?.ToString(), value, StringComparison.OrdinalIgnoreCase)) { combo.SelectedItem = item; return; }
        }
        if (combo.Items.Count > 0) combo.SelectedIndex = 0;
    }

    private static string ReadStringCombo(ComboBox combo, string fallback) =>
        (combo.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? fallback;

    private static int ReadIntCombo(ComboBox combo, int fallback) =>
        int.TryParse(ReadStringCombo(combo, fallback.ToString(CultureInfo.InvariantCulture)), out var result) ? result : fallback;

    private static Forms.ContextMenuStrip BuildTrayMenu()
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Show Spool", null, (_, _) => System.Windows.Application.Current.Dispatcher.Invoke(() => ((MainWindow)System.Windows.Application.Current.MainWindow!).RestoreFromTray()));
        menu.Items.Add("Exit", null, (_, _) => System.Windows.Application.Current.Dispatcher.Invoke(async () => await ((MainWindow)System.Windows.Application.Current.MainWindow!).ExitFromTrayAsync()));
        return menu;
    }

    private Forms.NotifyIcon CreateTrayIcon()
    {
        var executable = Process.GetCurrentProcess().MainModule?.FileName;
        var icon = !string.IsNullOrWhiteSpace(executable) ? System.Drawing.Icon.ExtractAssociatedIcon(executable) : null;
        var tray = new Forms.NotifyIcon
        {
            Text = "Spool — Instant Replay",
            Icon = icon ?? System.Drawing.SystemIcons.Application,
            ContextMenuStrip = _trayMenu,
            Visible = true
        };
        tray.DoubleClick += (_, _) => Dispatcher.Invoke(RestoreFromTray);
        return tray;
    }

    private void RestoreFromTray()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    private async Task ExitFromTrayAsync()
    {
        if (_allowExit) return;
        _allowExit = true;
        _pollTimer.Stop();
        _hotkeys?.Dispose();
        await _discord.DisposeAsync();
        await _host.StopAsync();
        _api.Dispose();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        Close();
        System.Windows.Application.Current.Shutdown();
    }

    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Maximize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    private void Close_Click(object sender, RoutedEventArgs e) => Hide();

    private void MainWindow_Closing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_allowExit) return;
        e.Cancel = true;
        Hide();
    }

    private void UpdateLoginOptionFromRegistry()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(RunKey, false);
            LaunchAtLoginCheck.IsChecked = key?.GetValue("Spool") is string;
        }
        catch { LaunchAtLoginCheck.IsChecked = _appSettings.LaunchAtLogin; }
    }

    private static void SetLaunchAtLogin(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, true);
        if (key is null) return;
        if (enabled)
        {
            var executable = Process.GetCurrentProcess().MainModule?.FileName;
            if (!string.IsNullOrWhiteSpace(executable)) key.SetValue("Spool", $"\"{executable}\"");
        }
        else key.DeleteValue("Spool", false);
    }
}
