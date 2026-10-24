using Windows.ApplicationModel.Activation;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace XboxShell
{
    /// <summary>App entry point.</summary>
    public sealed partial class App : Application
    {
        public App()
        {
            InitializeComponent();
            ApplicationViewScaling.TrySetDisableLayoutScaling(true);

            // XAML apps default to the mouse-cursor mode on Xbox. Turn it off: the UI is driven by focus.
            RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested;
#if VBISECT
            return;
#endif
            UnhandledException += (s, e) =>
            {
                MainPage.NativeLog("UNHANDLED " + e.Exception);
                e.Handled = true;
            };

            // Playback keeps its HDMI mode after stop (deferred restore); give the TV back its default on suspend.
            Suspending += async (s, e) =>
            {
                var deferral = e.SuspendingOperation.GetDeferral();
                try
                {
                    if (MainPage.Current != null)
                    {
                        await MainPage.Current.RestoreDisplayModeAsync("suspend");
                    }
                }
                catch (System.Exception ex)
                {
                    MainPage.NativeLog("suspend restore failed " + ex.Message);
                }
                finally
                {
                    deferral.Complete();
                }
            };
        }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
        {
            // Draw edge to edge; the web UI handles the TV-safe area itself.
            ApplicationView.GetForCurrentView().SetDesiredBoundsMode(ApplicationViewBoundsMode.UseCoreWindow);

#if VBARE
            Window.Current.Content = new TextBlock { Text = "BARE VARIANT", FontSize = 60, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            Window.Current.Activate();
            return;
#endif
            if (!(Window.Current.Content is Frame frame))
            {
                frame = new Frame();
                Window.Current.Content = frame;
            }

            if (frame.Content == null)
            {
                frame.Navigate(typeof(MainPage), e.Arguments);
            }

            Window.Current.Activate();
#if !VBISECT
            MainPage.NativeLog("activated, prelaunch=" + e.PrelaunchActivated);
#endif
        }
    }
}
