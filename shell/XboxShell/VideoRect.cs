// Picture-in-picture (bridge `setVideoRect` / `setPipSubs`, capabilities `pip`, `pipSubs`; docs/bridge.md "Picture in picture").
//
// The video is the MediaPlayerElement BEHIND the transparent WebView. In PiP the web pages are opaque again, so the
// video can't show through a hole: instead the element is moved onto the web's PiP window and raised ABOVE the WebView
// (Canvas.ZIndex). It never takes input (IsHitTestVisible=false, IsTabStop=false), so controller focus and key events
// stay in the WebView. rect = null puts it back: full window, behind the WebView.
//
// The element's LAYOUT never changes (always the full window): PiP is a render transform (uniform scale + translate)
// that fits it into the rect. So the video surface is never resized, and a move is a pure compositor animation
// (`anim: true`: storyboard on the transform + the clip's corner radius, PipAnimMs, ease-out). The web sequences the
// page switch while the video covers the whole screen (web/src/lib/pip.ts "Transitions"):
//   enter: rect = whole page (raised, no anim) -> page switches under it -> window rect with anim (shrinks);
//   leave: rect = whole page with anim (grows over the page) -> page switches under it -> null (drops behind).
//
// Coordinates are CSS px of the page plus the page's viewport size (vw, vh); they're scaled to the XAML root, so the
// UI supersampling experiment (UiMode.cs ss=2) and any window size map correctly. Rounded corners = a composition
// geometric clip on the element's visual, top corners only (the web's progress line sits right under the video).
//
// Subtitles: the web layer draws them, but in PiP the video covers that part of the page, so the web sends the current
// cue text (`setPipSubs {text}`) and a TextBlock above the video shows it (hidden while full screen or moving).
//
// Match frame rate: entering PiP does NOT restore the default display mode (an HDMI switch blanks the TV for seconds
// and would interrupt the video), so the browsing UI may run at the film's 23.976 Hz while PiP is up. Logged only.
using System;
using System.Numerics;
using Windows.Data.Json;
using Windows.Foundation;
using Windows.Graphics.Display.Core;
using Windows.UI;
using Windows.UI.Composition;
using Windows.UI.Text;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.UI.Xaml.Hosting;
using Windows.UI.Xaml.Media;
using Windows.UI.Xaml.Media.Animation;

namespace XboxShell
{
    public sealed partial class MainPage
    {
        private const double PipAnimMs = 360;

        /// <summary>Last PiP message with a rect in page CSS px (null = full screen), re-applied when the player element is created.</summary>
        private JsonObject _videoRect;

        // Transform the video has now (or is animating to): uniform scale + translate in root px, visible corner radius.
        private double _curS = 1;
        private double _curX;
        private double _curY;
        private double _curR;

        /// <summary>The PiP box in root px while the video sits in a window (null = full size: no subtitle overlay).</summary>
        private Rect? _boxRect;
        private Storyboard _rectAnim;
        private int _rectAnimToken;
        private CompositeTransform _videoXf;

        private string _pipSubsText = string.Empty;
        private Grid _pipSubsHost;
        private Border _pipSubsBox;
        private TextBlock _pipSubsBlock;

        private void SetVideoRect(JsonObject msg)
        {
            JsonObject rect = null;
            if (msg.TryGetValue("rect", out var rv) && rv.ValueType == JsonValueType.Object)
            {
                rect = rv.GetObject();
            }

            var anim = msg.TryGetValue("anim", out var av) && av.ValueType == JsonValueType.Boolean && av.GetBoolean();
            _videoRect = rect == null ? null : msg;
            ApplyVideoRect(anim);

            var mode = string.Empty;
            try
            {
                mode = ModeText(HdmiDisplayInformation.GetForCurrentView()?.GetCurrentDisplayMode());
            }
            catch
            {
                // no HDMI info (desktop)
            }

            var how = anim ? " (anim)" : string.Empty;
            NativeLog(rect == null ? $"videoRect full screen{how}" : $"videoRect pip {rect.Stringify()}{how} display={mode} (mode kept)");
            var ack = new JsonObject { ["rect"] = rect == null ? (IJsonValue)JsonValue.CreateNullValue() : JsonObject.Parse(rect.Stringify()) };
            Send("videoRect", ack);
        }

        private void SetPipSubs(JsonObject msg)
        {
            _pipSubsText = msg.GetNamedString("text", string.Empty) ?? string.Empty;
            UpdatePipSubs();
        }

        private void ApplyVideoRect(bool animate = false)
        {
            if (_player == null)
            {
                return;
            }

            _player.IsHitTestVisible = false;
            _player.IsTabStop = false;
            if (_videoXf == null || !ReferenceEquals(_player.RenderTransform, _videoXf))
            {
                _videoXf = new CompositeTransform();
                _player.RenderTransform = _videoXf;
                _curS = 1;
                _curX = _curY = _curR = 0;
            }

            // Layout: always the full window (see the header). Only the transform moves it.
            _player.HorizontalAlignment = HorizontalAlignment.Stretch;
            _player.VerticalAlignment = VerticalAlignment.Stretch;
            _player.Width = double.NaN;
            _player.Height = double.NaN;
            _player.Margin = new Thickness(0);
            StopRectAnim();

            var w = Root.ActualWidth;
            var h = Root.ActualHeight;
            double s = 1, x = 0, y = 0, radius = 0;
            Rect? box = null;
            var raise = false;
            var rect = _videoRect?.GetNamedObject("rect", null);
            if (rect != null && w > 0 && h > 0)
            {
                var vw = _videoRect.GetNamedNumber("vw", 0);
                var vh = _videoRect.GetNamedNumber("vh", 0);
                var sx = vw > 0 ? w / vw : 1;
                var sy = vh > 0 ? h / vh : 1;
                var bx = rect.GetNamedNumber("x", 0) * sx;
                var by = rect.GetNamedNumber("y", 0) * sy;
                var bw = Math.Max(16, rect.GetNamedNumber("w", 0) * sx);
                var bh = Math.Max(9, rect.GetNamedNumber("h", 0) * sy);
                s = Math.Min(1, Math.Min(bw / w, bh / h));
                x = bx + ((bw - (w * s)) / 2);
                y = by + ((bh - (h * s)) / 2);
                radius = _videoRect.GetNamedNumber("radius", 0) * sx;
                raise = true;
                if (s < 0.999)
                {
                    box = new Rect(bx, by, bw, bh);
                }
            }

            var moved = Math.Abs(s - _curS) > 0.001 || Math.Abs(x - _curX) > 0.5 || Math.Abs(y - _curY) > 0.5;
            var canAnim = animate && moved && _player.Visibility == Visibility.Visible;
            var fromS = _curS;
            var fromX = _curX;
            var fromY = _curY;
            var fromR = _curR;
            _curS = s;
            _curX = x;
            _curY = y;
            _curR = radius;
            _boxRect = box;

            if (raise)
            {
                Canvas.SetZIndex(_player, 10); // above the WebView (which keeps focus: the element is not hit-testable)
            }

            // Local values = the target (a later Stop() falls back to these).
            _videoXf.ScaleX = s;
            _videoXf.ScaleY = s;
            _videoXf.TranslateX = x;
            _videoXf.TranslateY = y;

            if (!canAnim)
            {
                if (!raise)
                {
                    Canvas.SetZIndex(_player, 0);
                }

                SetClip(w, h, radius / s, null);
                UpdatePipSubs();
                _web?.Focus(FocusState.Programmatic);
                return;
            }

            var dur = new Duration(TimeSpan.FromMilliseconds(PipAnimMs));
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            var sb = new Storyboard();
            void Add(string prop, double from, double to)
            {
                var da = new DoubleAnimation { From = from, To = to, Duration = dur, EasingFunction = ease };
                Storyboard.SetTarget(da, _videoXf);
                Storyboard.SetTargetProperty(da, prop);
                sb.Children.Add(da);
            }

            Add("ScaleX", fromS, s);
            Add("ScaleY", fromS, s);
            Add("TranslateX", fromX, x);
            Add("TranslateY", fromY, y);

            // The clip is in the element's own (unscaled) space: visible radius = clip radius × scale.
            SetClip(w, h, fromR / fromS, radius / s);

            var token = _rectAnimToken;
            sb.Completed += (o, e) =>
            {
                if (token != _rectAnimToken)
                {
                    return;
                }

                _rectAnim = null;
                if (!raise)
                {
                    Canvas.SetZIndex(_player, 0);
                    ElementCompositionPreview.GetElementVisual(_player).Clip = null;
                }

                UpdatePipSubs();
            };
            _rectAnim = sb;
            sb.Begin();
            UpdatePipSubs(); // hidden while it moves
            _web?.Focus(FocusState.Programmatic);
        }

        private void StopRectAnim()
        {
            _rectAnimToken++;
            if (_rectAnim != null)
            {
                _rectAnim.Stop();
                _rectAnim = null;
            }
        }

        /// <summary>
        /// Top-rounded clip of the w×h element (its own space). The geometry runs past the bottom edge by the radius, so
        /// only the top corners are rounded. Animates the radius to `toRadius` when given.
        /// </summary>
        private void SetClip(double w, double h, double radius, double? toRadius)
        {
            var visual = ElementCompositionPreview.GetElementVisual(_player);
            try
            {
                var end = toRadius ?? radius;
                if (radius <= 0.5 && end <= 0.5)
                {
                    visual.Clip = null;
                    return;
                }

                var c = visual.Compositor;
                var geo = c.CreateRoundedRectangleGeometry();
                geo.Size = new Vector2((float)w, (float)(h + Math.Max(radius, end)));
                geo.CornerRadius = new Vector2((float)radius, (float)radius);
                visual.Clip = c.CreateGeometricClip(geo);
                if (toRadius.HasValue && Math.Abs(end - radius) > 0.5)
                {
                    var a = c.CreateVector2KeyFrameAnimation();
                    a.InsertKeyFrame(1f, new Vector2((float)end, (float)end), c.CreateCubicBezierEasingFunction(new Vector2(0.33f, 1f), new Vector2(0.68f, 1f)));
                    a.Duration = TimeSpan.FromMilliseconds(PipAnimMs);
                    geo.StartAnimation("CornerRadius", a);
                }
            }
            catch (Exception ex)
            {
                NativeLog("videoRect clip failed: " + ex.Message);
            }
        }

        /// <summary>Subtitle line over the PiP video: shown only while the video sits in its window (not moving).</summary>
        private void UpdatePipSubs()
        {
            var r = _boxRect;
            var show = r.HasValue && _rectAnim == null && !string.IsNullOrWhiteSpace(_pipSubsText);
            if (!show)
            {
                if (_pipSubsHost != null)
                {
                    _pipSubsHost.Visibility = Visibility.Collapsed;
                }

                return;
            }

            if (_pipSubsHost == null)
            {
                _pipSubsBlock = new TextBlock
                {
                    Foreground = new SolidColorBrush(Colors.White),
                    FontWeight = FontWeights.SemiBold,
                    TextWrapping = TextWrapping.Wrap,
                    TextAlignment = TextAlignment.Center,
                    IsHitTestVisible = false,
                };
                _pipSubsBox = new Border
                {
                    Background = new SolidColorBrush(Color.FromArgb(166, 0, 0, 0)),
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Bottom,
                    IsHitTestVisible = false,
                    Child = _pipSubsBlock,
                };
                _pipSubsHost = new Grid
                {
                    HorizontalAlignment = HorizontalAlignment.Left,
                    VerticalAlignment = VerticalAlignment.Top,
                    IsHitTestVisible = false,
                };
                _pipSubsHost.Children.Add(_pipSubsBox);
                Canvas.SetZIndex(_pipSubsHost, 11); // above the raised video
                Root.Children.Add(_pipSubsHost);
            }

            var b = r.Value;
            var fs = Math.Max(12, b.Height * 0.075);
            _pipSubsHost.Margin = new Thickness(b.X, b.Y, 0, 0);
            _pipSubsHost.Width = b.Width;
            _pipSubsHost.Height = b.Height;
            _pipSubsBox.Margin = new Thickness(b.Width * 0.05, 0, b.Width * 0.05, b.Height * 0.05);
            _pipSubsBox.Padding = new Thickness(fs * 0.35, fs * 0.08, fs * 0.35, fs * 0.12);
            _pipSubsBox.CornerRadius = new CornerRadius(fs * 0.18);
            _pipSubsBlock.FontSize = fs;
            _pipSubsBlock.Text = _pipSubsText;
            _pipSubsHost.Visibility = Visibility.Visible;
        }
    }
}
