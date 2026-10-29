// Picture-in-picture (bridge `setVideoRect`, capability `pip: true`; docs/bridge.md "Picture in picture").
//
// The video is the MediaPlayerElement BEHIND the transparent WebView. In PiP the web pages are opaque again, so the
// video can't show through a hole: instead the element is sized/positioned to the web's PiP window and raised ABOVE
// the WebView (Canvas.ZIndex). It never takes input (IsHitTestVisible=false, IsTabStop=false), so controller focus and
// key events stay in the WebView. rect = null puts it back: full window, behind the WebView.
//
// Coordinates are CSS px of the page plus the page's viewport size (vw, vh); they're scaled to the XAML root, so the
// UI supersampling experiment (UiMode.cs ss=2) and any window size map correctly. Rounded corners = a composition
// geometric clip on the element's visual (cheap; skipped silently if the API isn't there).
//
// Match frame rate: entering PiP does NOT restore the default display mode (an HDMI switch blanks the TV for seconds
// and would interrupt the video), so the browsing UI may run at the film's 23.976 Hz while PiP is up. Logged only.
using System;
using System.Numerics;
using Windows.Data.Json;
using Windows.Graphics.Display.Core;
using Windows.UI.Composition;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Hosting;

namespace XboxShell
{
    public sealed partial class MainPage
    {
        /// <summary>Last PiP rect in page CSS px (null = full screen), re-applied when the player element is created.</summary>
        private JsonObject _videoRect;

        private void SetVideoRect(JsonObject msg)
        {
            JsonObject rect = null;
            if (msg.TryGetValue("rect", out var rv) && rv.ValueType == JsonValueType.Object)
            {
                rect = rv.GetObject();
            }

            _videoRect = rect == null ? null : msg;
            ApplyVideoRect();

            var mode = string.Empty;
            try
            {
                mode = ModeText(HdmiDisplayInformation.GetForCurrentView()?.GetCurrentDisplayMode());
            }
            catch
            {
                // no HDMI info (desktop)
            }

            NativeLog(rect == null ? "videoRect full screen" : $"videoRect pip {rect.Stringify()} display={mode} (mode kept)");
            var ack = new JsonObject { ["rect"] = rect == null ? (IJsonValue)JsonValue.CreateNullValue() : JsonObject.Parse(rect.Stringify()) };
            Send("videoRect", ack);
        }

        private void ApplyVideoRect()
        {
            if (_player == null)
            {
                return;
            }

            _player.IsHitTestVisible = false;
            _player.IsTabStop = false;
            var visual = ElementCompositionPreview.GetElementVisual(_player);
            var rect = _videoRect?.GetNamedObject("rect", null);
            if (rect == null)
            {
                Canvas.SetZIndex(_player, 0);
                _player.HorizontalAlignment = HorizontalAlignment.Stretch;
                _player.VerticalAlignment = VerticalAlignment.Stretch;
                _player.Width = double.NaN;
                _player.Height = double.NaN;
                _player.Margin = new Thickness(0);
                visual.Clip = null;
                return;
            }

            var vw = _videoRect.GetNamedNumber("vw", 0);
            var vh = _videoRect.GetNamedNumber("vh", 0);
            var sx = vw > 0 && Root.ActualWidth > 0 ? Root.ActualWidth / vw : 1;
            var sy = vh > 0 && Root.ActualHeight > 0 ? Root.ActualHeight / vh : 1;
            var x = rect.GetNamedNumber("x", 0) * sx;
            var y = rect.GetNamedNumber("y", 0) * sy;
            var w = Math.Max(16, rect.GetNamedNumber("w", 0) * sx);
            var h = Math.Max(9, rect.GetNamedNumber("h", 0) * sy);
            var radius = _videoRect.GetNamedNumber("radius", 0) * sx;

            _player.HorizontalAlignment = HorizontalAlignment.Left;
            _player.VerticalAlignment = VerticalAlignment.Top;
            _player.Width = w;
            _player.Height = h;
            _player.Margin = new Thickness(x, y, 0, 0);
            Canvas.SetZIndex(_player, 10); // above the WebView (which keeps focus: the element is not hit-testable)

            try
            {
                if (radius > 0)
                {
                    var c = visual.Compositor;
                    var geo = c.CreateRoundedRectangleGeometry();
                    geo.Size = new Vector2((float)w, (float)h);
                    geo.CornerRadius = new Vector2((float)radius, (float)radius);
                    visual.Clip = c.CreateGeometricClip(geo);
                }
                else
                {
                    visual.Clip = null;
                }
            }
            catch (Exception ex)
            {
                NativeLog("videoRect clip failed: " + ex.Message);
            }

            _web?.Focus(FocusState.Programmatic);
        }
    }
}
