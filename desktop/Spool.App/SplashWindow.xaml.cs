using System.Windows;

namespace Spool.App;

public partial class SplashWindow : Window
{
    public SplashWindow() => InitializeComponent();

    public void SetStatus(string status) => StatusText.Text = status;
}
