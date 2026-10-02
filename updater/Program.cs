using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
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

public sealed class DownloadedRelease
{
    public string TagName { get; set; }
    public string InstallerPath { get; set; }
}

public sealed class UpdaterForm : Form
{
    private const string LatestReleaseUrl = "https://api.github.com/repos/testaccount2109/clipfarm/releases/latest";
    private readonly Label messageLabel;
    private readonly ProgressBar progressBar;
    private readonly BackgroundWorker worker;

    public UpdaterForm()
    {
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
        worker.DoWork += DownloadLatestRelease;
        worker.ProgressChanged += UpdateStatus;
        worker.RunWorkerCompleted += StartInstaller;
        Shown += BeginUpdate;
    }

    private void BeginUpdate(object sender, EventArgs e)
    {
        if (IsClipfarmRunning())
        {
            MessageBox.Show(this,
                "Beende Clipfarm zuerst vollständig über das Tray-Menü und starte den Updater danach erneut.",
                "Clipfarm ist noch geöffnet", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
            return;
        }

        worker.RunWorkerAsync();
    }

    private void DownloadLatestRelease(object sender, DoWorkEventArgs e)
    {
        BackgroundWorker background = (BackgroundWorker)sender;
        string installerPath = null;
        string checksumPath = null;
        try
        {
            background.ReportProgress(0, "Prüfe die neueste Clipfarm-Version auf GitHub …");
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            ReleaseInfo release;
            using (WebClient client = CreateWebClient())
            using (MemoryStream stream = new MemoryStream(Encoding.UTF8.GetBytes(client.DownloadString(LatestReleaseUrl))))
            {
                DataContractJsonSerializer serializer = new DataContractJsonSerializer(typeof(ReleaseInfo));
                release = (ReleaseInfo)serializer.ReadObject(stream);
            }

            ReleaseAsset installer = null;
            ReleaseAsset checksum = null;
            if (release != null && release.Assets != null)
            {
                foreach (ReleaseAsset asset in release.Assets)
                {
                    if (asset == null || String.IsNullOrEmpty(asset.Name)) continue;
                    if (asset.Name.StartsWith("clipfarm-Setup-", StringComparison.OrdinalIgnoreCase)
                        && asset.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) installer = asset;
                }
                if (installer != null)
                {
                    foreach (ReleaseAsset asset in release.Assets)
                    {
                        if (asset != null && String.Equals(asset.Name, installer.Name + ".sha256", StringComparison.OrdinalIgnoreCase)) checksum = asset;
                    }
                }
            }

            if (installer == null || checksum == null || String.IsNullOrEmpty(release.TagName))
                throw new InvalidOperationException("Die neueste GitHub-Version enthält keinen Installer mit SHA-256-Prüfsumme.");

            string safeTag = Regex.Replace(release.TagName, "[^A-Za-z0-9._-]", "_");
            string downloadDirectory = Path.Combine(Path.GetTempPath(), "clipfarm-updater");
            Directory.CreateDirectory(downloadDirectory);
            installerPath = Path.Combine(downloadDirectory, "clipfarm-Setup-" + safeTag + ".exe");
            checksumPath = installerPath + ".sha256";

            background.ReportProgress(0, "Lade Clipfarm " + release.TagName + " herunter …");
            using (WebClient client = CreateWebClient()) client.DownloadFile(installer.DownloadUrl, installerPath);
            using (WebClient client = CreateWebClient()) client.DownloadFile(checksum.DownloadUrl, checksumPath);

            background.ReportProgress(0, "Prüfe den Installer …");
            string[] checksumParts = File.ReadAllText(checksumPath).Split((char[])null, StringSplitOptions.RemoveEmptyEntries);
            if (checksumParts.Length == 0 || !Regex.IsMatch(checksumParts[0], "^[A-Fa-f0-9]{64}$"))
                throw new InvalidOperationException("Die Prüfsumme aus dem GitHub-Release ist ungültig.");

            string actualHash;
            using (SHA256 hash = SHA256.Create())
            using (FileStream file = File.OpenRead(installerPath))
            {
                actualHash = BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
            }

            if (!String.Equals(actualHash, checksumParts[0], StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Die SHA-256-Prüfung ist fehlgeschlagen. Der Installer wird nicht gestartet.");

            e.Result = new DownloadedRelease { TagName = release.TagName, InstallerPath = installerPath };
        }
        catch
        {
            TryDelete(installerPath);
            throw;
        }
        finally
        {
            TryDelete(checksumPath);
        }
    }

    private void UpdateStatus(object sender, ProgressChangedEventArgs e)
    {
        messageLabel.Text = Convert.ToString(e.UserState);
    }

    private void StartInstaller(object sender, RunWorkerCompletedEventArgs e)
    {
        progressBar.Style = ProgressBarStyle.Blocks;
        if (e.Error != null)
        {
            messageLabel.Text = "Das Update konnte nicht gestartet werden.";
            MessageBox.Show(this, e.Error.Message, "Clipfarm-Updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }

        if (IsClipfarmRunning())
        {
            messageLabel.Text = "Clipfarm ist noch geöffnet.";
            MessageBox.Show(this,
                "Clipfarm wurde während des Downloads geöffnet. Beende es vollständig über das Tray-Menü und starte den Updater erneut.",
                "Clipfarm ist noch geöffnet", MessageBoxButtons.OK, MessageBoxIcon.Information);
            Close();
            return;
        }

        DownloadedRelease release = (DownloadedRelease)e.Result;
        try
        {
            Process.Start(new ProcessStartInfo(release.InstallerPath) { UseShellExecute = true });
            messageLabel.Text = "Der Installer für " + release.TagName + " wurde geöffnet.";
            Close();
        }
        catch (Exception error)
        {
            messageLabel.Text = "Der Installer konnte nicht geöffnet werden.";
            MessageBox.Show(this, error.Message, "Clipfarm-Updater", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
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
        try
        {
            foreach (Process process in processes)
            {
                using (process)
                {
                    try { if (!process.HasExited) return true; }
                    catch { }
                }
            }
        }
        finally
        {
            foreach (Process process in processes)
            {
                try { process.Dispose(); }
                catch { }
            }
        }
        return false;
    }

    private static void TryDelete(string path)
    {
        if (String.IsNullOrEmpty(path)) return;
        try { if (File.Exists(path)) File.Delete(path); }
        catch { }
    }
}

public static class Program
{
    [STAThread]
    public static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new UpdaterForm());
    }
}
