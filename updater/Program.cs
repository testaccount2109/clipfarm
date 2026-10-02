using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using System.Windows.Forms;

[DataContract]
public sealed class ReleaseInfo
{
    [DataMember(Name = "tag_name")]
    public string TagName { get; set; }

    [DataMember(Name = "assets")]
    public ReleaseAsset[] Assets { get; set; }
}

[DataContract]
public sealed class ReleaseAsset
{
    [DataMember(Name = "name")]
    public string Name { get; set; }

    [DataMember(Name = "browser_download_url")]
    public string DownloadUrl { get; set; }
}

public sealed class UpdateRequest
{
    public string InstallDirectory { get; set; }
    public Version InstalledVersion { get; set; }
}

public sealed class UpdateResult
{
    public string TagName { get; set; }
    public string AppPath { get; set; }
    public bool Updated { get; set; }
}

internal sealed class ChangedFile
{
    public string Destination { get; set; }
    public string Backup { get; set; }
    public bool Existed { get; set; }
}

public sealed class UpdaterForm : Form
{
    private const string LatestReleaseUrl = "https://api.github.com/repos/testaccount2109/clipfarm/releases/latest";
    private const string RegistryInstallKey = "Software\\Clipfarm\\Updater";
    private readonly Label messageLabel;
    private readonly ProgressBar progressBar;
    private readonly BackgroundWorker worker;
    private readonly int parentProcessId;
    private Timer parentExitTimer;
    private DateTime parentWaitDeadline;

    public UpdaterForm(int parentProcessId)
    {
        this.parentProcessId = parentProcessId;
        Text = "Clipfarm Updater";
        Width = 500;
        Height = 170;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ShowIcon = true;

        messageLabel = new Label();
        messageLabel.Left = 22;
        messageLabel.Top = 24;
        messageLabel.Width = 440;
        messageLabel.Height = 42;
        messageLabel.Text = "Prüfe die neueste Clipfarm-Version …";
        Controls.Add(messageLabel);

        progressBar = new ProgressBar();
        progressBar.Left = 22;
        progressBar.Top = 78;
        progressBar.Width = 440;
        progressBar.Height = 20;
        progressBar.Style = ProgressBarStyle.Marquee;
        Controls.Add(progressBar);

        worker = new BackgroundWorker();
        worker.WorkerReportsProgress = true;
        worker.DoWork += DownloadAndApplyUpdate;
        worker.ProgressChanged += UpdateStatus;
        worker.RunWorkerCompleted += LaunchUpdatedApp;
        Shown += BeginUpdate;
    }

    private void BeginUpdate(object sender, EventArgs e)
    {
        if (parentProcessId > 0 && IsProcessRunning(parentProcessId))
        {
            messageLabel.Text = "Warte, bis Clipfarm vollständig geschlossen ist …";
            parentWaitDeadline = DateTime.UtcNow.AddSeconds(90);
            parentExitTimer = new Timer();
            parentExitTimer.Interval = 300;
            parentExitTimer.Tick += WaitForParentExit;
            parentExitTimer.Start();
            return;
        }

        StartUpdate();
    }

    private void WaitForParentExit(object sender, EventArgs e)
    {
        if (!IsProcessRunning(parentProcessId))
        {
            parentExitTimer.Stop();
            parentExitTimer.Dispose();
            parentExitTimer = null;
            StartUpdate();
            return;
        }

        if (DateTime.UtcNow < parentWaitDeadline) return;
        parentExitTimer.Stop();
        parentExitTimer.Dispose();
        parentExitTimer = null;
        MessageBox.Show(this,
            "Clipfarm konnte nicht vollständig geschlossen werden. Bitte beende die Anwendung und starte sie erneut.",
            "Clipfarm-Updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
        Close();
    }

    private void StartUpdate()
    {
        if (IsClipfarmRunning())
        {
            MessageBox.Show(this,
                "Beende Clipfarm zuerst vollständig über das Tray-Menü und starte den Updater danach erneut.",
                "Clipfarm ist noch geöffnet", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
            return;
        }

        string installDirectory;
        try
        {
            installDirectory = FindInstallDirectory();
        }
        catch (Exception error)
        {
            MessageBox.Show(this, error.Message, "Clipfarm-Updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        worker.RunWorkerAsync(new UpdateRequest
        {
            InstallDirectory = installDirectory,
            InstalledVersion = ReadInstalledVersion(Path.Combine(installDirectory, "clipfarm.exe"))
        });
    }

    private void DownloadAndApplyUpdate(object sender, DoWorkEventArgs e)
    {
        BackgroundWorker background = (BackgroundWorker)sender;
        UpdateRequest request = (UpdateRequest)e.Argument;
        string workingDirectory = Path.Combine(Path.GetTempPath(), "clipfarm-updater", Guid.NewGuid().ToString("N"));
        string archivePath = Path.Combine(workingDirectory, "clipfarm-update.zip");
        string checksumPath = archivePath + ".sha256";

        try
        {
            Directory.CreateDirectory(workingDirectory);
            background.ReportProgress(0, "Prüfe die neueste Clipfarm-Version auf GitHub …");
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            ReleaseInfo release;
            using (WebClient client = CreateWebClient())
            using (MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes(client.DownloadString(LatestReleaseUrl))))
            {
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(ReleaseInfo));
                release = (ReleaseInfo)serializer.ReadObject(stream);
            }

            Version releaseVersion = ParseVersion(release == null ? null : release.TagName);
            if (release == null || release.Assets == null || releaseVersion == null)
                throw new InvalidOperationException("Die neueste GitHub-Version hat keine gültige Versionsnummer.");

            string expectedArchiveName = "clipfarm-App-" + releaseVersion.ToString(3) + ".zip";
            ReleaseAsset appArchive = null;
            ReleaseAsset checksum = null;
            foreach (ReleaseAsset asset in release.Assets)
            {
                if (asset == null || String.IsNullOrEmpty(asset.Name)) continue;
                if (String.Equals(asset.Name, expectedArchiveName, StringComparison.OrdinalIgnoreCase)) appArchive = asset;
                if (String.Equals(asset.Name, expectedArchiveName + ".sha256", StringComparison.OrdinalIgnoreCase)) checksum = asset;
            }

            if (appArchive == null || checksum == null)
                throw new InvalidOperationException("Das GitHub-Release enthält kein Clipfarm-Updatepaket mit SHA-256-Prüfsumme.");

            if (request.InstalledVersion != null && request.InstalledVersion.CompareTo(releaseVersion) >= 0)
            {
                e.Result = new UpdateResult { TagName = release.TagName, AppPath = Path.Combine(request.InstallDirectory, "clipfarm.exe"), Updated = false };
                return;
            }

            background.ReportProgress(0, "Lade die Update-Dateien für Clipfarm " + release.TagName + " herunter …");
            using (WebClient client = CreateWebClient()) client.DownloadFile(appArchive.DownloadUrl, archivePath);
            using (WebClient client = CreateWebClient()) client.DownloadFile(checksum.DownloadUrl, checksumPath);

            background.ReportProgress(0, "Prüfe die Update-Dateien …");
            VerifyChecksum(archivePath, checksumPath);

            if (IsClipfarmRunning())
                throw new InvalidOperationException("Clipfarm wurde während des Downloads geöffnet. Beende Clipfarm vollständig und starte den Updater erneut.");

            background.ReportProgress(0, "Installiere das Update und behalte deine Daten …");
            ApplyUpdate(archivePath, request.InstallDirectory, releaseVersion, background);

            e.Result = new UpdateResult
            {
                TagName = release.TagName,
                AppPath = Path.Combine(request.InstallDirectory, "clipfarm.exe"),
                Updated = true
            };
        }
        finally
        {
            TryDeleteDirectory(workingDirectory);
        }
    }

    private void UpdateStatus(object sender, ProgressChangedEventArgs e)
    {
        messageLabel.Text = Convert.ToString(e.UserState);
    }

    private void LaunchUpdatedApp(object sender, RunWorkerCompletedEventArgs e)
    {
        progressBar.Style = ProgressBarStyle.Blocks;
        if (e.Error != null)
        {
            messageLabel.Text = "Das Update konnte nicht abgeschlossen werden.";
            MessageBox.Show(this, e.Error.Message, "Clipfarm-Updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        UpdateResult result = (UpdateResult)e.Result;
        if (!result.Updated)
        {
            messageLabel.Text = "Clipfarm ist bereits aktuell (" + result.TagName + ").";
            CloseAfterBriefMessage();
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(result.AppPath)
            {
                WorkingDirectory = Path.GetDirectoryName(result.AppPath),
                UseShellExecute = true
            });
            messageLabel.Text = "Clipfarm wurde auf " + result.TagName + " aktualisiert.";
            CloseAfterBriefMessage();
        }
        catch (Exception error)
        {
            messageLabel.Text = "Clipfarm wurde aktualisiert, konnte aber nicht gestartet werden.";
            MessageBox.Show(this, error.Message, "Clipfarm-Updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    private void CloseAfterBriefMessage()
    {
        Timer timer = new Timer();
        timer.Interval = 1600;
        timer.Tick += delegate
        {
            timer.Stop();
            timer.Dispose();
            Close();
        };
        timer.Start();
    }

    private static string FindInstallDirectory()
    {
        List<string> registeredPaths = new List<string>();
        AddRegisteredPath(registeredPaths, RegistryHive.CurrentUser, RegistryView.Default, RegistryInstallKey);
        AddRegisteredPath(registeredPaths, RegistryHive.LocalMachine, RegistryView.Default, RegistryInstallKey);
        if (registeredPaths.Count == 1) return registeredPaths[0];
        if (registeredPaths.Count > 1)
            throw new InvalidOperationException("Es wurden mehrere Clipfarm-Installationen gefunden. Bitte starte den Updater aus dem Ordner der gewünschten Installation.");

        List<string> legacyPaths = FindLegacyInstallDirectories();
        if (legacyPaths.Count == 1) return legacyPaths[0];
        if (legacyPaths.Count > 1)
            throw new InvalidOperationException("Es wurden mehrere Clipfarm-Installationen gefunden. Bitte entferne alte Installationen und starte den Updater erneut.");

        throw new InvalidOperationException("Der Clipfarm-Installationsordner wurde nicht gefunden. Installiere Clipfarm zuerst mit dem Setup und starte dann den Updater.");
    }

    private static void AddRegisteredPath(List<string> paths, RegistryHive hive, RegistryView view, string keyName)
    {
        try
        {
            using (RegistryKey baseKey = RegistryKey.OpenBaseKey(hive, view))
            using (RegistryKey key = baseKey.OpenSubKey(keyName))
            {
                if (key != null) AddIfValidInstall(paths, Convert.ToString(key.GetValue("InstallLocation")));
            }
        }
        catch { /* registry view may not exist on this Windows installation */ }
    }

    private static List<string> FindLegacyInstallDirectories()
    {
        List<string> paths = new List<string>();
        RegistryView[] views = Environment.Is64BitOperatingSystem
            ? new RegistryView[] { RegistryView.Registry64, RegistryView.Registry32 }
            : new RegistryView[] { RegistryView.Registry32 };
        RegistryHive[] hives = new RegistryHive[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine };

        foreach (RegistryHive hive in hives)
        {
            foreach (RegistryView view in views)
            {
                try
                {
                    using (RegistryKey baseKey = RegistryKey.OpenBaseKey(hive, view))
                    using (RegistryKey uninstall = baseKey.OpenSubKey("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall"))
                    {
                        if (uninstall == null) continue;
                        foreach (string subKeyName in uninstall.GetSubKeyNames())
                        {
                            using (RegistryKey entry = uninstall.OpenSubKey(subKeyName))
                            {
                                if (entry == null) continue;
                                string displayName = Convert.ToString(entry.GetValue("DisplayName"));
                                if (String.IsNullOrEmpty(displayName) || !displayName.StartsWith("clipfarm", StringComparison.OrdinalIgnoreCase)) continue;
                                string uninstallCommand = Convert.ToString(entry.GetValue("UninstallString"));
                                string uninstallPath = GetExecutablePath(uninstallCommand);
                                if (!String.IsNullOrEmpty(uninstallPath)) AddIfValidInstall(paths, Path.GetDirectoryName(uninstallPath));
                            }
                        }
                    }
                }
                catch { /* inaccessible registry hives are skipped */ }
            }
        }

        return paths;
    }

    private static string GetExecutablePath(string command)
    {
        if (String.IsNullOrEmpty(command)) return null;
        Match quoted = Regex.Match(command, "^\\s*\"(?<path>[^\"]+\\.exe)\"", RegexOptions.IgnoreCase);
        if (quoted.Success) return quoted.Groups["path"].Value;
        Match unquoted = Regex.Match(command, "^\\s*(?<path>.+?\\.exe)(?:\\s|$)", RegexOptions.IgnoreCase);
        return unquoted.Success ? unquoted.Groups["path"].Value.Trim('"') : null;
    }

    private static void AddIfValidInstall(List<string> paths, string candidate)
    {
        if (String.IsNullOrWhiteSpace(candidate)) return;
        try
        {
            string fullPath = Path.GetFullPath(candidate.Trim());
            if (!File.Exists(Path.Combine(fullPath, "clipfarm.exe"))) return;
            foreach (string path in paths)
            {
                if (String.Equals(path, fullPath, StringComparison.OrdinalIgnoreCase)) return;
            }
            paths.Add(fullPath);
        }
        catch { /* malformed registry paths are ignored */ }
    }

    private static Version ReadInstalledVersion(string executablePath)
    {
        try { return ParseVersion(FileVersionInfo.GetVersionInfo(executablePath).ProductVersion); }
        catch { return null; }
    }

    private static Version ParseVersion(string value)
    {
        if (String.IsNullOrEmpty(value)) return null;
        Match match = Regex.Match(value, "(?<version>\\d+\\.\\d+(?:\\.\\d+){0,2})");
        Version parsed;
        if (!match.Success || !Version.TryParse(match.Groups["version"].Value, out parsed)) return null;
        return new Version(parsed.Major, Math.Max(parsed.Minor, 0), Math.Max(parsed.Build, 0), Math.Max(parsed.Revision, 0));
    }

    private static void VerifyChecksum(string archivePath, string checksumPath)
    {
        string[] checksumParts = File.ReadAllText(checksumPath).Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
        if (checksumParts.Length == 0 || !Regex.IsMatch(checksumParts[0], "^[A-Fa-f0-9]{64}$"))
            throw new InvalidOperationException("Die Prüfsumme aus dem GitHub-Release ist ungültig.");

        string actualHash;
        using (SHA256 hash = SHA256.Create())
        using (FileStream file = File.OpenRead(archivePath))
        {
            actualHash = BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
        }

        if (!String.Equals(actualHash, checksumParts[0], StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Die SHA-256-Prüfung ist fehlgeschlagen. Das Update wurde nicht installiert.");
    }

    private static void ApplyUpdate(string archivePath, string installDirectory, Version expectedVersion, BackgroundWorker background)
    {
        string stagingDirectory = Path.Combine(Path.GetTempPath(), "clipfarm-update-stage-" + Guid.NewGuid().ToString("N"));
        string backupDirectory = Path.Combine(Path.GetTempPath(), "clipfarm-update-backup-" + Guid.NewGuid().ToString("N"));
        List<ChangedFile> changedFiles = new List<ChangedFile>();
        bool preserveBackups = false;

        try
        {
            Directory.CreateDirectory(stagingDirectory);
            Directory.CreateDirectory(backupDirectory);
            List<string> relativeFiles = ExtractArchive(archivePath, stagingDirectory);
            string stagedAppPath = Path.Combine(stagingDirectory, "clipfarm.exe");
            if (!File.Exists(stagedAppPath)) throw new InvalidOperationException("Das Updatepaket enthält keine Clipfarm-Anwendung.");

            Version packageVersion = ReadInstalledVersion(stagedAppPath);
            if (packageVersion == null || packageVersion.CompareTo(expectedVersion) != 0)
                throw new InvalidOperationException("Die Versionsnummer in den Update-Dateien stimmt nicht mit dem Release überein.");

            if (IsClipfarmRunning())
                throw new InvalidOperationException("Clipfarm ist noch geöffnet. Beende Clipfarm vollständig und starte den Updater erneut.");

            string installRoot = Path.GetFullPath(installDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            for (int index = 0; index < relativeFiles.Count; index++)
            {
                string relativePath = relativeFiles[index];
                string destination = Path.GetFullPath(Path.Combine(installRoot, relativePath));
                if (!destination.StartsWith(installRoot, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Das Updatepaket enthält einen ungültigen Dateipfad.");

                string parentDirectory = Path.GetDirectoryName(destination);
                Directory.CreateDirectory(parentDirectory);
                string backupPath = Path.Combine(backupDirectory, relativePath);
                bool existed = File.Exists(destination);
                if (existed)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(backupPath));
                    File.Copy(destination, backupPath, true);
                }

                ChangedFile change = new ChangedFile { Destination = destination, Backup = backupPath, Existed = existed };
                changedFiles.Add(change);
                ReplaceFile(Path.Combine(stagingDirectory, relativePath), destination);

                if (background != null && relativeFiles.Count > 0)
                {
                    int percent = (index + 1) * 100 / relativeFiles.Count;
                    background.ReportProgress(percent, "Installiere Clipfarm " + expectedVersion + " … " + percent + "%");
                }
            }
        }
        catch (Exception updateError)
        {
            if (!RollBack(changedFiles))
            {
                preserveBackups = true;
                throw new InvalidOperationException("Das Update ist fehlgeschlagen und konnte nicht vollständig zurückgesetzt werden. Die Wiederherstellungsdateien liegen hier: " + backupDirectory, updateError);
            }
            throw;
        }
        finally
        {
            TryDeleteDirectory(stagingDirectory);
            if (!preserveBackups) TryDeleteDirectory(backupDirectory);
        }
    }

    private static List<string> ExtractArchive(string archivePath, string stagingDirectory)
    {
        List<string> files = new List<string>();
        HashSet<string> uniqueFiles = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string stagingRoot = Path.GetFullPath(stagingDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        long totalUncompressedBytes = 0;

        using (FileStream file = File.OpenRead(archivePath))
        using (ZipArchive archive = new ZipArchive(file, ZipArchiveMode.Read))
        {
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string entryPath = entry.FullName.Replace('/', '\\');
                if (String.IsNullOrEmpty(entryPath) || Path.IsPathRooted(entryPath) || entryPath.StartsWith("\\", StringComparison.Ordinal))
                    throw new InvalidOperationException("Das Updatepaket enthält einen ungültigen Dateipfad.");

                string[] parts = entryPath.Split('\\');
                foreach (string part in parts)
                {
                    if (part == "." || part == "..") throw new InvalidOperationException("Das Updatepaket enthält einen ungültigen Dateipfad.");
                }

                string destination = Path.GetFullPath(Path.Combine(stagingRoot, entryPath));
                if (!destination.StartsWith(stagingRoot, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Das Updatepaket enthält einen ungültigen Dateipfad.");

                int unixType = (entry.ExternalAttributes >> 16) & 0xF000;
                if (unixType == 0xA000) throw new InvalidOperationException("Das Updatepaket enthält einen nicht unterstützten symbolischen Link.");

                if (entry.FullName.EndsWith("/", StringComparison.Ordinal) || entry.FullName.EndsWith("\\", StringComparison.Ordinal))
                {
                    Directory.CreateDirectory(destination);
                    continue;
                }

                if (!uniqueFiles.Add(entryPath)) throw new InvalidOperationException("Das Updatepaket enthält doppelte Dateinamen.");
                totalUncompressedBytes += entry.Length;
                if (entry.Length > 1024L * 1024L * 1024L || totalUncompressedBytes > 4L * 1024L * 1024L * 1024L)
                    throw new InvalidOperationException("Das Updatepaket ist zu groß oder ungültig.");

                Directory.CreateDirectory(Path.GetDirectoryName(destination));
                using (Stream input = entry.Open())
                using (FileStream output = File.Create(destination)) input.CopyTo(output);
                files.Add(entryPath);
            }
        }

        if (files.Count == 0) throw new InvalidOperationException("Das Updatepaket ist leer.");
        return files;
    }

    private static void ReplaceFile(string source, string destination)
    {
        string temporaryPath = destination + ".clipfarm-update-" + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.Copy(source, temporaryPath, true);
            if (File.Exists(destination))
            {
                File.SetAttributes(destination, FileAttributes.Normal);
                File.Replace(temporaryPath, destination, null);
            }
            else
            {
                File.Move(temporaryPath, destination);
            }
        }
        finally
        {
            TryDeleteFile(temporaryPath);
        }
    }

    private static bool RollBack(List<ChangedFile> changedFiles)
    {
        bool succeeded = true;
        for (int index = changedFiles.Count - 1; index >= 0; index--)
        {
            ChangedFile change = changedFiles[index];
            try
            {
                if (change.Existed && File.Exists(change.Backup))
                {
                    File.SetAttributes(change.Destination, FileAttributes.Normal);
                    File.Copy(change.Backup, change.Destination, true);
                }
                else if (!change.Existed && File.Exists(change.Destination))
                {
                    File.SetAttributes(change.Destination, FileAttributes.Normal);
                    File.Delete(change.Destination);
                }
            }
            catch { succeeded = false; /* retain the remaining backups and continue best-effort rollback */ }
        }
        return succeeded;
    }

    private static WebClient CreateWebClient()
    {
        WebClient client = new WebClient();
        client.Headers[HttpRequestHeader.UserAgent] = "Clipfarm-Updater";
        client.Headers[HttpRequestHeader.Accept] = "application/vnd.github+json";
        return client;
    }

    private static bool IsClipfarmRunning()
    {
        Process[] processes = Process.GetProcessesByName("clipfarm");
        foreach (Process process in processes)
        {
            using (process)
            {
                try { if (!process.HasExited) return true; }
                catch { }
            }
        }
        return false;
    }

    private static bool IsProcessRunning(int processId)
    {
        try
        {
            using (Process process = Process.GetProcessById(processId)) return !process.HasExited;
        }
        catch (ArgumentException) { return false; }
        catch { return true; }
    }

    private static void TryDeleteFile(string path)
    {
        if (String.IsNullOrEmpty(path)) return;
        try { if (File.Exists(path)) File.Delete(path); }
        catch { }
    }

    private static void TryDeleteDirectory(string path)
    {
        if (String.IsNullOrEmpty(path)) return;
        try { if (Directory.Exists(path)) Directory.Delete(path, true); }
        catch { }
    }
}

public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        int parentProcessId = 0;
        foreach (string argument in args)
        {
            const string prefix = "--wait-pid=";
            if (argument.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                Int32.TryParse(argument.Substring(prefix.Length), out parentProcessId);
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new UpdaterForm(parentProcessId));
    }
}
