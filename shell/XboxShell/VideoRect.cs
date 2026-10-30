// Picture-in-picture (bridge `setVideoRect` / `setPipSubs`, capabilities `pip`, `pipSubs`; docs/bridge.md "Picture in picture").
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
// anim: true = move from where the video is now to the new rect (render-transform storyboard + clip corner animation,
// both on the compositor). Entering: the web first raises the video at full size (rect = the whole page, no anim), then
// sends the window rect with anim, so the page swap under it is never seen and the picture shrinks into the corner.
// Leaving (rect null + anim): it grows back to full screen while still above the WebView, then drops behind it.
//
// Subtitles: the web layer draws them, but in PiP the video covers that part of the page, so the web sends the current
// cue text (`setPipSubs {text}`) and a TextBlock above the video shows it (hidden while full screen or animating).
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

        /// <summary>Last PiP rect in page CSS px (null = full screen), re-applied when the player element is created.</summary>
        private JsonObject _videoRect;

        /// <summary>Where the video is drawn now, in root px (null = full window, behind the WebView).</summary>
        private Rect? _shownRect;
        private double _shownRadius;
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

            var anim = msg.GetNamedBoolean("anim", false);
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

            NativeLog(rect == null ? $"videoRect full screen{(anim ? " (anim)" : string.Empty)}" : $"videoRect pip {rect.Stringify()}{(anim ? " (anim)" : string.Empty)} display={mode} (mode kept)");
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
            if (_videoXf == null)
            {
                _videoXf = new CompositeTransform();
                _player.RenderTransform = _videoXf;
            }

            StopRectAnim();
            var full = new Rect(0, 0, Root.ActualWidth, Root.ActualHeight);
            var from = _shownRect ?? full;
            var fromRadius = _shownRect == null ? 0 : _shownRadius;
            var canAnim = animate && _player.Visibility == Visibility.Visible && full.Width > 0 && full.Height > 0;

            var rect = _videoRect?.GetNamedObject("rect", null);
            if (rect == null)
            {
                var wasRaised = _shownRect != null;
                _shownRect = null;
                _shownRadius = 0;
                UpdatePipSubs();
                if (!canAnim || !wasRaised)
                {
                    PlaceFull();
                    return;
                }

                // Grow back to full screen above the WebView, then drop behind it.
                Place(full);
                AnimateFrom(from, full, fromRadius, 0, PlaceFull);
                return;
            }

            var vw = _videoRect.GetNamedNumber("vw", 0);
            var vh = _videoRect.GetNamedNumber("vh", 0);
            var sx = vw > 0 && full.Width > 0 ? full.Width / vw : 1;
            var sy = vh > 0 && full.Height > 0 ? full.Height / vh : 1;
            var to = new Rect(
                rect.GetNamedNumber("x", 0) * sx,
                rect.GetNamedNumber("y", 0) * sy,
                Math.Max(16, rect.GetNamedNumber("w", 0) * sx),
                Math.Max(9, rect.GetNamedNumber("h", 0) * sy));
            var radius = _videoRect.GetNamedNumber("radius", 0) * sx;

            _shownRect = to;
            _shownRadius = radius;
            Place(to);
            if (canAnim && from != to)
            {
                AnimateFrom(from, to, fromRadius, radius, UpdatePipSubs);
                UpdatePipSubs(); // hidden while it moves (shown by the animation's done)
            }
            else
            {
                SetClip(to.Width, to.Height, radius, null);
                UpdatePipSubs();
            }

            _web?.Focus(FocusState.Programmatic);
        }

        /// <summary>Lay the element out at r (root px), above the WebView. No transform, no clip change.</summary>
        private void Place(Rect r)
        {
            _player.HorizontalAlignment = HorizontalAlignment.Left;
            _player.VerticalAlignment = VerticalAlignment.Top;
            _player.Width = r.Width;
            _player.Height = r.Height;
            _player.Margin = new Thickness(r.X, r.Y, 0, 0);
            Canvas.SetZIndex(_player, 10); // above the WebView (which keeps focus: the element is not hit-testable)
        }

        /// <summary>Normal player: full window, behind the WebView.</summary>
        private void PlaceFull()
        {
            if (_player == null)
            {
                return;
            }

            Canvas.SetZIndex(_player, 0);
            _player.HorizontalAlignment = HorizontalAlignment.Stretch;
            _player.VerticalAlignment = VerticalAlignment.Stretch;
            _player.Width = double.NaN;
            _player.Height = double.NaN;
            _player.Margin = new Thickness(0);
            ResetXf();
            ElementCompositionPreview.GetElementVisual(_player).Clip = null;
        }

        /// <summary>The element is already laid out at `to`; draw it at `from` and ease to identity.</summary>
        private void AnimateFrom(Rect from, Rect to, double fromRadius, double toRadius, Action done)
        {
            var scaleX = from.Width / to.Width;
            var scaleY = from.Height / to.Height;
            _videoXf.ScaleX = scaleX;
            _videoXf.ScaleY = scaleY;
            _videoXf.TranslateX = from.X - to.X;
            _videoXf.TranslateY = from.Y - to.Y;

            var dur = new Duration(TimeSpan.FromMilliseconds(PipAnimMs));
            var ease = new CubicEase { EasingMode = EasingMode.EaseOut };
            var sb = new Storyboard();
            void Add(string prop, double a)
            {
                var da = new DoubleAnimation { From = a, To = prop.StartsWith("Scale") ? 1 : 0, Duration = dur, EasingFunction = ease };
                Storyboard.SetTarget(da, _videoXf);
                Storyboard.SetTargetProperty(da, prop);
                sb.Children.Add(da);
            }

            Add("ScaleX", scaleX);
            Add("ScaleY", scaleY);
            Add("TranslateX", from.X - to.X);
            Add("TranslateY", from.Y - to.Y);

            // The clip lives in the element's (target) space, so it is scaled with it: start at fromRadius as seen.
            SetClip(to.Width, to.Height, fromRadius / Math.Max(0.01, scaleX), toRadius);

            var token = ++_rectAnimToken;
            sb.Completed += (s, e) =>
            {
                if (token != _rectAnimToken)
                {
                    return;
                }

                _rectAnim = null;
                ResetXf();
                done?.Invoke();
            };
            _rectAnim = sb;
            sb.Begin();
        }

        private void StopRectAnim()
        {
            _rectAnimToken++;
            if (_rectAnim != null)
            {
                _rectAnim.Stop();
                _rectAnim = null;
            }

            ResetXf();
        }

        private void ResetXf()
        {
            if (_videoXf == null)
            {
                return;
            }

            _videoXf.ScaleX = 1;
            _videoXf.ScaleY = 1;
            _videoXf.TranslateX = 0;
            _videoXf.TranslateY = 0;
        }

        /// <summary>Rounded clip of w×h; animates the corner radius from `radius` to `toRadius` when given.</summary>
        private void SetClip(double w, double h, double radius, double? toRadius)
        {
            var visual = ElementCompositionPreview.GetElementVisual(_player);
            try
            {
                var end = toRadius ?? radius;
                if (radius <= 0 && end <= 0)
                {
                    visual.Clip = null;
                    return;
                }

                var c = visual.Compositor;
                var geo = c.CreateRoundedRectangleGeometry();
                geo.Size = new Vector2((float)w, (float)h);
                geo.CornerRadius = new Vector2((float)radius, (float)radius);
                visual.Clip = c.CreateGeometricClip(geo);
                if (toRadius.HasValue && Math.Abs(toRadius.Value - radius) > 0.5)
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
            var r = _shownRect;
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
                    Children = { _pipSubsBox },
                };
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
