using System.Text.Json;

namespace Spool.App;

public sealed class AppSettings
{
    public bool StartReplayOnLaunch { get; set; } = true;
    public bool LaunchAtLogin { get; set; }
    public bool DiscordPresenceEnabled { get; set; }
    public string DiscordApplicationId { get; set; } = "";

    public static string DataDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Spool");

    private static string SettingsPath => Path.Combine(DataDirectory, "app-settings.json");

    public static AppSettings Load()
    {
        try
        {
            Directory.CreateDirectory(DataDirectory);
            return JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(SettingsPath), JsonDefaults.Options) ?? new AppSettings();
        }
        catch { return new AppSettings(); }
    }

    public void Save()
    {
        Directory.CreateDirectory(DataDirectory);
        var temporaryPath = SettingsPath + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(this, JsonDefaults.IndentedOptions));
        File.Move(temporaryPath, SettingsPath, true);
    }
}
