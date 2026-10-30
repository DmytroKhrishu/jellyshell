using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using FFmpegInteropX;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using Windows.Data.Json;
using Windows.Graphics.Display.Core;
using Windows.Media.Core;
using Windows.Media.MediaProperties;
using Windows.Media.Playback;
using Windows.Media.Streaming.Adaptive;
using Windows.System.Display;
using Windows.UI.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using Windows.Web.Http;

namespace XboxShell
{
    /// <summary>
    /// Hosts the web UI (transparent WebView2, on top) and owns native playback (MediaPlayerElement behind it,
    /// HDMI mode switching). Bridge contract: docs/bridge.md (v1).
    /// </summary>
    public sealed partial class MainPage : Page
    {
        // UI source per side (media/dash) is resolved at launch/switch: saved → build defaults → bundled (UiSource.cs).
        // Native log lines follow the resolved MEDIA page server; null (bundled mode / nothing configured) = drop them silently.
        private static Uri _logBase = UiSource.FirstMediaCandidate;

        private string _side = UiSource.Media;
        private string _uiSource = "none";
        private bool _dashReachable;
        private string _pendingUnavailable;
        private bool _switching;

        private static readonly string[] FfmpegAudio = { "truehd", "mlp", "dts", "dca" };

        private WebView2 _web;
        private MediaPlayerElement _player;
        private MediaPlayer _mp;

        // Created lazily: constructing a DisplayRequest before Window.Activate() keeps the Xbox splash screen up forever.
        private DisplayRequest _displayRequest;
        private bool _displayActive;
        private bool _playing;
        private bool _modeSwitched;

        // Current playback
        private JsonObject _playMsg;
        private MediaPlaybackItem _item;
        private string _path = "none";       // "mf" | "ffmpeg"
        private bool _fellBack;
        private JsonObject _caps;

        private int _frames;

        public static MainPage Current { get; private set; }

        public MainPage()
        {
            InitializeComponent();
            Current = this;
            Windows.UI.Xaml.Media.CompositionTarget.Rendering += (s, e) => _frames++;
            Loaded += OnLoaded;
            SystemNavigationManager.GetForCurrentView().BackRequested += OnBackRequested;
        }

        private static readonly HttpClient LogClient = new HttpClient();

        /// <summary>Native-side diagnostics straight to the POC server (works even if WebView2 is broken).</summary>
        public static void NativeLog(string text)
        {
            try
            {
                var b = _logBase;
                if (b == null)
                {
                    return; // bundled mode: no page server to log to
                }

                // Relative "log" keeps the /jellyshell/ prefix on the public URL.
                _ = LogClient.PostAsync(new Uri(b, "log"), new HttpStringContent("NATIVE " + text)).AsTask()
                    .ContinueWith(t => { _ = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
            }
            catch
            {
                // ignore
            }
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            NativeLog($"loaded frames={_frames} window={Window.Current.Bounds.Width}x{Window.Current.Bounds.Height}");

            // WinUI2 WebView2 does not expose DefaultBackgroundColor; the runtime reads this env var at creation.
            // Documented WinUI2 transparency value is "00FFFFFF" (AARRGGBB) so the MediaPlayerElement behind it shows through transparent pages.
            Environment.SetEnvironmentVariable("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "00FFFFFF");

            // Small delay so the page is in the visual tree before WebView2 is added (focus quirk on Xbox).
            await Task.Delay(300);
            _web = new WebView2();
            _web.CoreWebView2Initialized += OnCoreInitialized;
            _web.WebMessageReceived += OnWebMessage;
            // The PiP rect + subtitle line belong to the page: a navigation (side switch, reload) starts a page that never
            // sent one, so the next playback must not open in the old window.
            _web.NavigationStarting += (s, a) => ResetVideoRect();
            _web.NavigationCompleted += (s, a) => Send("navigation", new JsonObject { ["ok"] = JsonValue.CreateBooleanValue(a.IsSuccess), ["status"] = JsonValue.CreateStringValue(a.WebErrorStatus.ToString()) });
            Root.Children.Add(_web);

            NativeLog("webview2 added, ensuring core");
            try
            {
                await _web.EnsureCoreWebView2Async();
                NativeLog("webview2 core ready");
            }
            catch (Exception ex)
            {
                ShowFatal("WebView2 failed to start: " + ex.Message);
                return;
            }

            try
            {
                if (UiSource.HasBundle)
                {
                    _web.CoreWebView2.SetVirtualHostNameToFolderMapping(UiSource.BundledHost, UiSource.BundledFolder, CoreWebView2HostResourceAccessKind.Allow);
                }
            }
            catch (Exception ex)
            {
                NativeLog("bundle mapping failed: " + ex.Message);
            }

            await StartSideAsync();

            // Probe once up front so it is in the log even before the page says hello.
            _caps = await BuildCapabilitiesAsync();
            NativeLog("CAPABILITIES " + _caps.Stringify());
        }

        private void OnCoreInitialized(WebView2 sender, CoreWebView2InitializedEventArgs args)
        {
            if (args.Exception != null)
            {
                ShowFatal("WebView2 init error: " + args.Exception.Message);
                return;
            }

            var s = _web.CoreWebView2.Settings;
            s.AreDefaultContextMenusEnabled = false;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;
            s.IsGeneralAutofillEnabled = false; // autofill pops the virtual keyboard on Xbox
            s.AreDevToolsEnabled = true;        // POC: keep remote debugging possible
            s.UserAgent += " JellyShell/0.2 Xbox";
            _web.Focus(FocusState.Programmatic);
        }

        // ---------- bridge ----------

        private void Send(string type, JsonObject payload = null)
        {
            if (_web?.CoreWebView2 == null)
            {
                return;
            }

            var msg = payload ?? new JsonObject();
            msg["type"] = JsonValue.CreateStringValue(type);
            try
            {
                // As JSON: the page receives a parsed object in e.data.
                _web.CoreWebView2.PostWebMessageAsJson(msg.Stringify());
            }
            catch (Exception ex)
            {
                NativeLog("send failed " + type + ": " + ex.Message);
            }
        }

        /// <summary>Send from any thread.</summary>
        private void SendUi(string type, JsonObject payload = null) => RunOnUiFireAndForget(() => Send(type, payload));

        private void SendError(string code, string message, bool fatal)
        {
            NativeLog($"error {code} fatal={fatal}: {message}");
            Send("error", new JsonObject
            {
                ["code"] = JsonValue.CreateStringValue(code),
                ["message"] = JsonValue.CreateStringValue(message),
                ["fatal"] = JsonValue.CreateBooleanValue(fatal),
            });
        }

        private static JsonObject ParseMessage(CoreWebView2WebMessageReceivedEventArgs args)
        {
            // Accept both postMessage(obj) and postMessage(JSON.stringify(obj)).
            try
            {
                var s = args.TryGetWebMessageAsString();
                if (JsonObject.TryParse(s, out var o))
                {
                    return o;
                }
            }
            catch
            {
                // not a string message
            }

            try
            {
                if (JsonObject.TryParse(args.WebMessageAsJson, out var o))
                {
                    return o;
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        private async void OnWebMessage(WebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            var msg = ParseMessage(args);
            if (msg == null)
            {
                return;
            }

            var type = msg.GetNamedString("type", string.Empty);
            if (type != "hello")
            {
                NativeLog("bridge <- " + Redact(msg.Stringify()));
            }

            try
            {
                switch (type)
                {
                    case "hello":
                        _caps ??= await BuildCapabilitiesAsync();
                        AddSideFields(_caps);
                        NativeLog($"hello -> side={_side} startSide={UiSource.StartSide} dash={_dashReachable} uiSource={_uiSource}");
                        Send("capabilities", _caps);
                        if (_pendingUnavailable != null)
                        {
                            Send("sideUnavailable", new JsonObject { ["side"] = JsonValue.CreateStringValue(_pendingUnavailable) });
                            _pendingUnavailable = null;
                        }

                        break;
                    case "switchSide":
                        await SwitchSideAsync(msg.GetNamedString("side", ""));
                        break;
                    case "setUiServer":
                        await SetUiServerAsync(msg);
                        break;
                    case "setStartSide":
                        {
                            var ss = msg.GetNamedString("side", "");
                            if (UiSource.IsSide(ss))
                            {
                                UiSource.StartSide = ss;
                                NativeLog("startSide=" + ss);
                            }

                            break;
                        }
                    case "play":
                        await PlayAsync(msg);
                        break;
                    case "pause":
                        _mp?.Pause();
                        break;
                    case "resume":
                        _mp?.Play();
                        break;
                    case "seek":
                        if (_mp != null)
                        {
                            _mp.PlaybackSession.Position = TimeSpan.FromMilliseconds(msg.GetNamedNumber("positionMs", 0));
                        }

                        break;
                    case "stop":
                        await StopAsync("stop", false);
                        // restore:"now" = the user left the player for the UI: give the TV its default mode at once
                        // (menus at 23.976 Hz feel laggy). Episode switches omit it and keep the deferred restore.
                        if (msg.GetNamedString("restore", "") == "now")
                        {
                            await RestoreDisplayModeAsync("ui");
                        }

                        break;
                    case "setAudioTrack":
                        SetAudioTrack((int)msg.GetNamedNumber("index", 0));
                        break;
                    case "setVolume":
                        if (_mp != null)
                        {
                            _mp.Volume = Math.Max(0, Math.Min(1, msg.GetNamedNumber("value", 1)));
                        }

                        break;
                    case "setAudioBoost":
                        await SetAudioBoostAsync(msg);
                        break;
                    case "setVideoRect":
                        SetVideoRect(msg);
                        break;
                    case "setPipSubs":
                        SetPipSubs(msg);
                        break;
                    case "exit":
                        await StopAsync("exit", false);
                        await RestoreDisplayModeAsync("exit");
                        Application.Current.Exit();
                        break;
                    case "displayProbe":
                        Send("displayInfo", await DisplayProbeAsync("bridge"));
                        break;
                    case "setUiMode":
                        await SetUiModeAsync(msg.GetNamedString("mode", "1080p"), (int)msg.GetNamedNumber("ss", 1));
                        break;
                    case "navigate":
                        // Debug-only (not in bridge v1): load another UI URL.
                        _web.Source = new Uri(msg.GetNamedString("url"));
                        break;
                }
            }
            catch (Exception ex)
            {
                SendError(type + "Failed", $"{ex.Message} (0x{ex.HResult:X8})", type == "play");
            }
        }

        // ---------- sides (media / dash), docs/store-release.md ----------

        private void AddSideFields(JsonObject caps)
        {
            caps["side"] = JsonValue.CreateStringValue(_side);
            caps["startSide"] = JsonValue.CreateStringValue(UiSource.StartSide);
            caps["sides"] = new JsonObject
            {
                ["media"] = JsonValue.CreateBooleanValue(true),
                ["dash"] = JsonValue.CreateBooleanValue(_dashReachable),
            };
            caps["uiSource"] = JsonValue.CreateStringValue(_uiSource);
            caps["uiServers"] = UiServersJson();
        }

        /// <summary>The user-saved page-server addresses (null = not set) plus the build-time defaults, for Settings.</summary>
        private static JsonObject UiServersJson()
        {
            return new JsonObject
            {
                ["media"] = UrlOrNull(UiSource.Saved(UiSource.Media)),
                ["dash"] = UrlOrNull(UiSource.Saved(UiSource.Dash)),
                ["defaults"] = new JsonObject
                {
                    ["media"] = UrlOrNull(UiSource.BuildDefault(UiSource.Media) ?? UiSource.BuildPublic),
                    ["dash"] = UrlOrNull(UiSource.BuildDefault(UiSource.Dash)),
                },
            };
        }

        private static IJsonValue UrlOrNull(Uri u) => u == null ? (IJsonValue)JsonValue.CreateNullValue() : JsonValue.CreateStringValue(u.ToString());

        private void Load(UiSource.Resolved r)
        {
            _side = r.Side;
            _uiSource = r.Source;
            if (r.Side == UiSource.Media)
            {
                _logBase = r.LogBase;
            }

            NativeLog($"ui side={r.Side} source={r.Source} url={r.Url}");
            if (r.Url == null)
            {
                // Local build without a bundled UI and without any configured page server: nothing to show.
                ShowFatal("No UI to load: this build has no bundled web UI and no JellyShell server address. See docs/building.md.");
                return;
            }

            _web.Source = r.Url;
        }

        /// <summary>Launch: resolve both sides in parallel, then load the persisted start side.</summary>
        private async Task StartSideAsync()
        {
            var start = UiSource.StartSide;
            var media = UiSource.ResolveMediaAsync();
            var dash = await UiSource.ResolveDashAsync();
            _dashReachable = dash != null;
            if (start == UiSource.Dash && dash != null)
            {
                Load(dash);
                // Native logs still go to the media page server once it is known (none when media is bundled).
                _logBase = (await media).LogBase;
                return;
            }

            if (start == UiSource.Dash)
            {
                _pendingUnavailable = UiSource.Dash; // told to the page after its hello
            }

            Load(await media);
        }

        /// <summary>
        /// Bridge setUiServer {side, url|null}: save (or clear) the user's page-server address for a side, re-resolve that side
        /// and load it when it is the visible one. Replies uiServer {side, ok, url, uiServers} or uiServer {side, ok:false, error}.
        /// The address must answer a probe before it is saved, so a typo can't strand the app on an unreachable page.
        /// </summary>
        private async Task SetUiServerAsync(JsonObject msg)
        {
            var side = msg.GetNamedString("side", "");
            if (!UiSource.IsSide(side))
            {
                ReplyUiServer(side, false, null, "unknown side");
                return;
            }

            Uri url = null;
            IJsonValue raw;
            if (msg.TryGetValue("url", out raw) && raw.ValueType == JsonValueType.String && !string.IsNullOrWhiteSpace(raw.GetString()))
            {
                url = UiSource.ParseServerUrl(raw.GetString());
                if (url == null)
                {
                    ReplyUiServer(side, false, null, "Enter a full http:// or https:// address.");
                    return;
                }

                if (!await UiSource.ProbeAsync(url))
                {
                    ReplyUiServer(side, false, url, "No JellyShell server answered at that address.");
                    return;
                }
            }

            UiSource.SetSaved(side, url);
            NativeLog($"uiServer {side} = {(url == null ? "(cleared)" : url.ToString())}");
            if (_caps != null)
            {
                _caps["uiServers"] = UiServersJson();
            }

            ReplyUiServer(side, true, url, null);

            if (side == UiSource.Dash)
            {
                var dash = await UiSource.ResolveDashAsync();
                _dashReachable = dash != null;
                if (_side == UiSource.Dash)
                {
                    if (dash != null)
                    {
                        Load(dash);
                    }
                    else
                    {
                        Load(await UiSource.ResolveMediaAsync());
                    }
                }
            }
            else
            {
                var media = await UiSource.ResolveMediaAsync();
                if (_side == UiSource.Media)
                {
                    if (_playing)
                    {
                        await StopAsync("setUiServer", false);
                        await RestoreDisplayModeAsync("ui");
                    }

                    Load(media);
                }
                else
                {
                    _logBase = media.LogBase;
                }
            }
        }

        private void ReplyUiServer(string side, bool ok, Uri url, string error)
        {
            if (!ok)
            {
                NativeLog($"uiServer {side} rejected: {error}");
            }

            var o = new JsonObject
            {
                ["side"] = JsonValue.CreateStringValue(side ?? ""),
                ["ok"] = JsonValue.CreateBooleanValue(ok),
                ["url"] = UrlOrNull(url),
                ["uiServers"] = UiServersJson(),
            };
            if (error != null)
            {
                o["error"] = JsonValue.CreateStringValue(error);
            }

            Send("uiServer", o);
        }

        private async Task SwitchSideAsync(string side)
        {
            if (!UiSource.IsSide(side) || _switching)
            {
                return;
            }

            _switching = true;
            try
            {
                if (_playing)
                {
                    await StopAsync("switchSide", false);
                    await RestoreDisplayModeAsync("ui");
                }

                if (side == UiSource.Dash)
                {
                    var dash = await UiSource.ResolveDashAsync();
                    _dashReachable = dash != null;
                    if (dash == null)
                    {
                        NativeLog("switchSide dash: unreachable");
                        Send("sideUnavailable", new JsonObject { ["side"] = JsonValue.CreateStringValue(UiSource.Dash) });
                        return;
                    }

                    Load(dash);
                }
                else
                {
                    Load(await UiSource.ResolveMediaAsync());
                }
            }
            finally
            {
                _switching = false;
            }
        }

        private static string Redact(string s)
        {
            return System.Text.RegularExpressions.Regex.Replace(s, "(api_key|ApiKey)=[0-9a-fA-F]+", "$1=<key>");
        }

        // ---------- back / B button ----------

        private void OnBackRequested(object sender, BackRequestedEventArgs e)
        {
            // Always handle it (unhandled back on Xbox can suspend the app). The web layer owns navigation,
            // including leaving the player, so just forward it.
            e.Handled = true;
            Send("back", new JsonObject { ["playing"] = JsonValue.CreateBooleanValue(_playing) });
        }

        // ---------- playback ----------

        private void EnsurePlayer()
        {
            if (_mp != null)
            {
                return;
            }

            _mp = new MediaPlayer { AutoPlay = true };
            _mp.MediaFailed += OnMediaFailed;
            _mp.MediaEnded += (s, a) => RunOnUiFireAndForget(async () =>
            {
                Send("playbackState", new JsonObject { ["state"] = JsonValue.CreateStringValue("Ended") });
                Send("playbackEnded");
                await StopAsync("ended", true);
            });
            _mp.MediaOpened += (s, a) => RunOnUiFireAndForget(() =>
            {
                NativeLog($"opened path={_path} natural={s.PlaybackSession.NaturalVideoWidth}x{s.PlaybackSession.NaturalVideoHeight} dur={s.PlaybackSession.NaturalDuration}");
                SendTracks();
            });
            _mp.PlaybackSession.PlaybackStateChanged += (s, a) => RunOnUiFireAndForget(() =>
            {
                if (!_playing)
                {
                    return;
                }

                Send("playbackState", new JsonObject
                {
                    ["state"] = JsonValue.CreateStringValue(s.PlaybackState == MediaPlaybackState.None ? "Stopped" : s.PlaybackState.ToString()),
                    ["videoWidth"] = JsonValue.CreateNumberValue(s.NaturalVideoWidth),
                    ["videoHeight"] = JsonValue.CreateNumberValue(s.NaturalVideoHeight),
                });
                SendTime();
            });
            _mp.PlaybackSession.SeekCompleted += (s, a) => RunOnUiFireAndForget(SendTime);
            _mp.PlaybackSession.BufferingStarted += (s, e) => _bufferings++;

            // Behind the WebView (index 0), no built-in controls: the web layer draws them.
            _player = new MediaPlayerElement
            {
                AreTransportControlsEnabled = false,
                Stretch = Windows.UI.Xaml.Media.Stretch.Uniform,
                IsTabStop = false,
                Visibility = Visibility.Collapsed,
            };
            Root.Children.Insert(0, _player);
            _player.SetMediaPlayer(_mp);
            ApplyVideoRect(); // a PiP rect sent before the first play

            _timeTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
            _timeTimer.Tick += (s, e) =>
            {
                var st = _mp?.PlaybackSession?.PlaybackState;
                if (_playing && (st == MediaPlaybackState.Playing || st == MediaPlaybackState.Buffering))
                {
                    SendTime();
                }
            };
            _heartbeat = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
            _heartbeat.Tick += (s, e) => Heartbeat();
        }

        private async Task PlayAsync(JsonObject msg)
        {
            if (_playing)
            {
                await StopAsync("replaced", false);
            }

            _playMsg = msg;
            _fellBack = false;
            var url = new Uri(msg.GetNamedString("url"));
            var startMs = msg.GetNamedNumber("startMs", 0);

            if (msg.TryGetValue("audioBoost", out var ab) && ab.ValueType == JsonValueType.Object)
            {
                ReadBoost(ab.GetObject());
            }

            EnsurePlayer();
            _playing = true;
            _path = "none";
            Send("playbackState", new JsonObject { ["state"] = JsonValue.CreateStringValue("Opening") });

            var item = await CreatePlaybackItemAsync(msg, url, preferFfmpeg: false);
            if (item == null)
            {
                await StopAsync("open failed", false);
                return;
            }

            // Switch only after the source opened, so a fatal open doesn't flap the HDMI mode.
            var modeResult = await SwitchDisplayModeAsync(msg);
            NativeLog("display: " + modeResult);

            AttachItem(item, startMs);
            AckBoostAfterOpen();
            ProbeDisplayLater(++_playToken);

            if (!_displayActive)
            {
                (_displayRequest ??= new DisplayRequest()).RequestActive();
                _displayActive = true;
            }

            // Video behind, transparent WebView on top keeps focus so the gamepad reaches the web layer.
            _player.Visibility = Visibility.Visible;
            _web.Focus(FocusState.Programmatic);
            _bufferings = 0;
            _hbWall = DateTime.MinValue;
            _heartbeat.Start();
            _timeTimer.Start();
        }

        private void AttachItem(MediaPlaybackItem item, double startMs)
        {
            _item = item;
            item.AudioTracksChanged += (s, a) => RunOnUiFireAndForget(SendTracks);
            var idx = _playMsg?.GetNamedNumber("audioStreamIndex", -1) ?? -1;
            _pendingAudioIndex = (int)idx;
            _mp.Source = item;
            if (startMs > 0)
            {
                _mp.PlaybackSession.Position = TimeSpan.FromMilliseconds(startMs);
            }

            _mp.Play();
        }

        private int _pendingAudioIndex = -1;

        private async Task StopAsync(string reason, bool fromEnd)
        {
            if (!_playing)
            {
                return;
            }

            _playing = false;
            _heartbeat?.Stop();
            _timeTimer?.Stop();
            var pos = _mp?.PlaybackSession?.Position ?? TimeSpan.Zero;
            NativeLog($"stop reason={reason} pos={pos.TotalSeconds:0.0}s path={_path}");
            _mp?.Pause();
            if (_mp != null)
            {
                _mp.Source = null;
            }

            _item = null;
            ReleaseFfmpeg();

            if (_player != null)
            {
                _player.Visibility = Visibility.Collapsed;
            }

            _web.Focus(FocusState.Programmatic);
            if (_displayActive)
            {
                try
                {
                    _displayRequest?.RequestRelease();
                }
                catch
                {
                    // not active
                }

                _displayActive = false;
            }

            // Keep the playback mode while browsing (back-to-back episodes = no HDMI blank); restore after idle.
            ScheduleDeferredRestore();
            if (!fromEnd)
            {
                Send("playbackState", new JsonObject
                {
                    ["state"] = JsonValue.CreateStringValue("Stopped"),
                    ["positionMs"] = JsonValue.CreateNumberValue(Math.Round(pos.TotalMilliseconds)),
                });
            }
        }

        // ---------- tracks / time ----------

        private void SendTracks()
        {
            var item = _item;
            if (item == null)
            {
                return;
            }

            var arr = new JsonArray();
            var log = new System.Text.StringBuilder("tracks:");
            for (var i = 0; i < item.AudioTracks.Count; i++)
            {
                var t = item.AudioTracks[i];
                string codec = null;
                uint ch = 0;
                if (_path == "ffmpeg" && _ffmpeg != null && i < _ffmpeg.AudioStreams.Count)
                {
                    var a = _ffmpeg.AudioStreams[i];
                    codec = a.CodecName;
                    ch = (uint)a.Channels;
                }

                try
                {
                    var p = t.GetEncodingProperties();
                    codec ??= AudioSubtypeName(p.Subtype);
                    if (ch == 0)
                    {
                        ch = p.ChannelCount;
                    }
                }
                catch
                {
                    // properties unavailable
                }

                arr.Add(new JsonObject
                {
                    ["index"] = JsonValue.CreateNumberValue(i),
                    ["codec"] = JsonValue.CreateStringValue(codec ?? "unknown"),
                    ["channels"] = JsonValue.CreateNumberValue(ch),
                    ["language"] = JsonValue.CreateStringValue(t.Language ?? string.Empty),
                    ["title"] = JsonValue.CreateStringValue(t.Label ?? string.Empty),
                });
                log.Append($" [{i}] {codec} {ch}ch {t.Language} '{t.Label}'");
            }

            NativeLog(log + $" selected={item.AudioTracks.SelectedIndex}");
            Send("tracks", new JsonObject
            {
                ["audio"] = arr,
                ["selected"] = JsonValue.CreateNumberValue(item.AudioTracks.SelectedIndex),
            });

            if (_pendingAudioIndex >= 0 && _pendingAudioIndex < item.AudioTracks.Count)
            {
                var want = _pendingAudioIndex;
                _pendingAudioIndex = -1;
                SetAudioTrack(want);
            }
        }

        private void SetAudioTrack(int index)
        {
            var item = _item;
            if (item == null || index < 0 || index >= item.AudioTracks.Count)
            {
                SendError("badAudioTrack", $"audio track {index} not available ({item?.AudioTracks.Count ?? 0} tracks)", false);
                return;
            }

            item.AudioTracks.SelectedIndex = index;
            NativeLog($"audio track -> {index} (now {item.AudioTracks.SelectedIndex})");
        }

        private DispatcherTimer _timeTimer;

        private void SendTime()
        {
            var ps = _mp?.PlaybackSession;
            if (ps == null || !_playing)
            {
                return;
            }

            var pos = ps.Position;
            var o = new JsonObject
            {
                ["positionMs"] = JsonValue.CreateNumberValue(Math.Round(pos.TotalMilliseconds)),
                // Progressive remux/transcode streams report TimeSpan.MaxValue; send 0 = unknown (use Jellyfin RunTimeTicks).
                ["durationMs"] = JsonValue.CreateNumberValue(ps.NaturalDuration.TotalDays > 30 ? 0 : Math.Round(ps.NaturalDuration.TotalMilliseconds)),
            };
            var buffered = BufferedEnd(ps, pos);
            if (buffered.HasValue)
            {
                o["bufferedMs"] = JsonValue.CreateNumberValue(Math.Round(buffered.Value.TotalMilliseconds));
            }

            Send("time", o);
        }

        private static TimeSpan? BufferedEnd(MediaPlaybackSession ps, TimeSpan pos)
        {
            try
            {
                var ranges = ps.GetBufferedRanges();
                foreach (var r in ranges)
                {
                    if (r.Start <= pos + TimeSpan.FromSeconds(1) && r.End >= pos)
                    {
                        return r.End;
                    }
                }
            }
            catch
            {
                // not supported by this source
            }

            return null;
        }

        // ---------- playback heartbeat (position vs wall clock, buffering) ----------

        private DispatcherTimer _heartbeat;
        private DateTime _hbWall;
        private TimeSpan _hbPos;
        private int _bufferings;

        private void Heartbeat()
        {
            var ps = _mp?.PlaybackSession;
            if (ps == null)
            {
                return;
            }

            var now = DateTime.UtcNow;
            var pos = ps.Position;
            var speed = _hbWall == DateTime.MinValue || ps.PlaybackState != MediaPlaybackState.Playing ? double.NaN : (pos - _hbPos).TotalSeconds / (now - _hbWall).TotalSeconds;
            _hbWall = now;
            _hbPos = pos;
            var buf = BufferedEnd(ps, pos);
            NativeLog($"hb path={_path} state={ps.PlaybackState} pos={pos.TotalSeconds:0.0}s speed={speed:0.00}x buffered={(buf.HasValue ? $"{(buf.Value - pos).TotalSeconds:0}s" : "?")} bufferings={_bufferings} natural={ps.NaturalVideoWidth}x{ps.NaturalVideoHeight}");
        }

        // ---------- source creation (MF default, FFmpegInteropX for TrueHD/DTS or MF failure) ----------

        // Must outlive playback: if the GC collects it, playback stops with an error.
        private FFmpegMediaSource _ffmpeg;
        private MediaSource _mfSource;

        private void ReleaseFfmpeg()
        {
            try
            {
                _ffmpeg?.Dispose();
            }
            catch
            {
                // already closed
            }

            _ffmpeg = null;
            try
            {
                _mfSource?.Dispose();
            }
            catch
            {
                // already closed
            }

            _mfSource = null;
        }

        private bool MfHasVideoDecoder(string codec)
        {
            var arr = _caps?.GetNamedArray("video", null);
            if (arr == null)
            {
                return codec != "av1";
            }

            return arr.Any(v => v.GetString() == codec) || (codec == "h265" && arr.Any(v => v.GetString() == "hevc")) || (codec == "avc" && arr.Any(v => v.GetString() == "h264"));
        }

        private static bool NeedsFfmpegAudio(string audioCodec)
        {
            var a = (audioCodec ?? string.Empty).ToLowerInvariant();
            return a == "truehd" || a == "mlp" || a.StartsWith("dts", StringComparison.Ordinal) || a == "dca";
        }

        private async Task<MediaPlaybackItem> CreatePlaybackItemAsync(JsonObject msg, Uri url, bool preferFfmpeg)
        {
            ReleaseFfmpeg();
            var audio = msg.GetNamedString("audioCodec", string.Empty);
            var engine = msg.GetNamedString("engine", string.Empty); // debug override: "mf" / "ffmpeg"
            var isHls = url.AbsolutePath.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase);
            var vcodec = msg.GetNamedString("videoCodec", string.Empty).ToLowerInvariant();
            // MF "plays" a stream whose video codec has no decoder (AV1 on Xbox: CodecQuery av1=0) as audio-only,
            // black picture, no error. Never send those to MF.
            var noMfVideo = vcodec.Length > 0 && !MfHasVideoDecoder(vcodec);
            if (noMfVideo && isHls && engine != "mf")
            {
                SendError("videoCodecUnsupported", $"no system decoder for {vcodec}; request an h264/hevc transcode", true);
                return null;
            }

            // Audio boost needs FFmpeg's audio filter graph (AudioBoost.cs), so boosted file playback takes the FFmpeg path.
            var useFfmpeg = engine == "ffmpeg" || (engine != "mf" && !isHls && (preferFfmpeg || NeedsFfmpegAudio(audio) || noMfVideo || BoostActive));
            var why = engine.Length > 0 ? "requested" : preferFfmpeg ? "fallback" : NeedsFfmpegAudio(audio) ? "audio=" + audio : noMfVideo ? "no MF " + vcodec + " decoder" : BoostActive ? "audio boost" : "default";
            if (noMfVideo && engine != "mf")
            {
                SendError("videoCodecSlow", $"no system {vcodec} decoder; FFmpeg decode may stutter at 4K, prefer a transcode", false);
            }

            if (!useFfmpeg)
            {
                try
                {
                    var t0 = DateTime.UtcNow;
                    if (isHls)
                    {
                        var r = await AdaptiveMediaSource.CreateFromUriAsync(url);
                        if (r.Status != AdaptiveMediaSourceCreationStatus.Success)
                        {
                            throw new Exception($"AdaptiveMediaSource {r.Status} http={r.HttpResponseMessage?.StatusCode} 0x{r.ExtendedError?.HResult:X8}");
                        }

                        NativeLog($"hls bitrates=[{string.Join(",", r.MediaSource.AvailableBitrates)}] live={r.MediaSource.IsLive}");
                        _mfSource = MediaSource.CreateFromAdaptiveMediaSource(r.MediaSource);
                    }
                    else
                    {
                        _mfSource = MediaSource.CreateFromUri(url);
                    }

                    // Open now so container/codec failures surface here and can fall back to FFmpeg.
                    await _mfSource.OpenAsync();
                    var item = new MediaPlaybackItem(_mfSource);
                    _path = "mf";
                    var summary = MfSummary(item) + (isHls ? " hls" : string.Empty);
                    NativeLog($"path=mf ({why}) open={(DateTime.UtcNow - t0).TotalMilliseconds:0}ms {summary}");
                    Send("decoder", new JsonObject
                    {
                        ["path"] = JsonValue.CreateStringValue("mf"),
                        ["summary"] = JsonValue.CreateStringValue(summary),
                    });
                    return item;
                }
                catch (Exception ex)
                {
                    ReleaseFfmpeg();
                    if (isHls || engine == "mf")
                    {
                        SendError("openFailed", $"MF open failed: {ex.Message} (0x{ex.HResult:X8})", true);
                        return null;
                    }

                    _fellBack = true;
                    NativeLog($"MF open failed (0x{ex.HResult:X8} {ex.Message}); falling back to FFmpegInteropX");
                    SendError("mfOpenFailed", $"Media Foundation could not open the stream (0x{ex.HResult:X8}); using FFmpeg", false);
                    why = "fallback";
                }
            }

            try
            {
                var codec = msg.GetNamedString("videoCodec", string.Empty).ToLowerInvariant();
                var cfg = new MediaSourceConfig();
                // HEVC/H264: ForceSystemDecoder = compressed passthrough to the Xbox hardware decoder (keeps HDR).
                // AutomaticSystemDecoder's CodecChecker reports HEVC NotAvailable on Xbox and falls to FFmpeg software.
                // AV1 has no MF passthrough in FFmpegInteropX (D3D11VA path, stutters at 4K).
                cfg.Video.VideoDecoderMode = codec == "av1" ? VideoDecoderMode.Automatic : VideoDecoderMode.ForceSystemDecoder;
                var mode = msg.GetNamedString("decoderMode", string.Empty);
                if (mode.Length > 0 && Enum.TryParse(mode, out VideoDecoderMode forced))
                {
                    cfg.Video.VideoDecoderMode = forced;
                }

                ConfigureBoost(cfg);
                cfg.General.ReadAheadBufferEnabled = true;
                cfg.General.ReadAheadBufferDuration = TimeSpan.FromSeconds(30);
                cfg.General.ReadAheadBufferSize = 200L * 1024 * 1024;
                cfg.FFmpegOptions = new Windows.Foundation.Collections.PropertySet
                {
                    { "reconnect", 1 },
                    { "reconnect_streamed", 1 },
                    { "reconnect_on_network_error", 1 },
                };

                var t0 = DateTime.UtcNow;
                _ffmpeg = await FFmpegMediaSource.CreateFromUriAsync(url.AbsoluteUri, cfg);
                _ffmpeg.PlaybackSession = _mp.PlaybackSession;
                var item = _ffmpeg.CreateMediaPlaybackItem();
                _path = "ffmpeg";
                LogStreams($"path=ffmpeg ({why}) mode={cfg.Video.VideoDecoderMode} open={(DateTime.UtcNow - t0).TotalMilliseconds:0}ms" + (BoostActive ? $" afilter='{BoostFilter()}'" : string.Empty));
                return item;
            }
            catch (Exception ex)
            {
                ReleaseFfmpeg();
                SendError("openFailed", $"FFmpeg open failed: {ex.Message} (0x{ex.HResult:X8})", true);
                return null;
            }
        }

        private static string MfSummary(MediaPlaybackItem item)
        {
            var sb = new System.Text.StringBuilder();
            try
            {
                if (item.VideoTracks.Count > 0)
                {
                    var v = item.VideoTracks[0].GetEncodingProperties();
                    sb.Append($"video={VideoSubtypeName(v.Subtype)} {v.Width}x{v.Height}");
                }

                if (item.AudioTracks.Count > 0)
                {
                    var a = item.AudioTracks[0].GetEncodingProperties();
                    sb.Append($" audio={AudioSubtypeName(a.Subtype)} {a.ChannelCount}ch");
                }

                sb.Append($" vtracks={item.VideoTracks.Count} atracks={item.AudioTracks.Count}");
            }
            catch (Exception ex)
            {
                sb.Append(" (props: " + ex.Message + ")");
            }

            return sb.ToString();
        }

        private void LogStreams(string header)
        {
            var sb = new System.Text.StringBuilder(header);
            var fi = _ffmpeg.FormatInfo;
            sb.Append($" | container={fi?.FormatName} dur={_ffmpeg.Duration}");
            foreach (var v in _ffmpeg.VideoStreams)
            {
                sb.Append($" | V#{v.StreamIndex} {v.CodecName} {v.PixelWidth}x{v.PixelHeight} {v.FramesPerSecond:0.###}fps {v.BitsPerSample}bit hw={v.HardwareDecoderStatus} engine={v.DecoderEngine}{(v.IsActive ? " *ACTIVE*" : string.Empty)}");
            }

            foreach (var a in _ffmpeg.AudioStreams)
            {
                sb.Append($" | A#{a.StreamIndex} {a.CodecName} {a.Channels}ch {a.SampleRate}Hz lang={a.Language} engine={a.DecoderEngine}{(a.IsActive ? " *ACTIVE*" : string.Empty)}");
            }

            var cv = _ffmpeg.CurrentVideoStream;
            var ca = _ffmpeg.CurrentAudioStream;
            var summary = $"video={cv?.CodecName}/{cv?.DecoderEngine} audio={ca?.CodecName}/{ca?.DecoderEngine} {ca?.Channels}ch";
            sb.Append(" | CURRENT ").Append(summary);
            NativeLog(sb.ToString());
            Send("decoder", new JsonObject
            {
                ["path"] = JsonValue.CreateStringValue("ffmpeg"),
                ["summary"] = JsonValue.CreateStringValue(summary),
            });
        }

        private void OnMediaFailed(MediaPlayer sender, MediaPlayerFailedEventArgs args)
        {
            var hr = args.ExtendedErrorCode?.HResult ?? 0;
            var pos = sender.PlaybackSession.Position;
            RunOnUiFireAndForget(async () =>
            {
                var text = $"MediaFailed {args.Error}: {args.ErrorMessage} (0x{hr:X8}) path={_path}";
                var msg = _playMsg;
                var canFallback = _playing && _path == "mf" && !_fellBack && msg != null
                    && msg.GetNamedString("engine", string.Empty) != "mf"
                    && !msg.GetNamedString("url", string.Empty).Contains(".m3u8");
                if (canFallback)
                {
                    _fellBack = true;
                    SendError("mfFailed", text + "; retrying with FFmpeg", false);
                    _mp.Source = null;
                    _item = null;
                    var item = await CreatePlaybackItemAsync(msg, new Uri(msg.GetNamedString("url")), preferFfmpeg: true);
                    if (item != null)
                    {
                        AttachItem(item, pos.TotalMilliseconds);
                        return;
                    }
                }
                else
                {
                    SendError("mediaFailed", text, true);
                }

                await StopAsync("failed", false);
            });
        }

        // ---------- HDMI ----------
        //
        // hdr=off: request modes with HdmiDisplayHdrOption.EotfSdr (explicit SDR EOTF), never None. None = "no
        // preference", which leaves the Xbox free to flip the TV into HDR10 once HDR10 frames reach the compositor.
        // A watchdog re-asserts SDR if the output still turns HDR during an hdr=off playback.
        //
        // Mode changes blank the TV for seconds, so: never request the mode we're already in, keep the playback mode
        // after stop (back-to-back episodes), restore the default after 5 s idle, on exit or on suspend.

        // 5 s, not 60: until the restore the UI renders at the movie rate (23.976 Hz = visibly laggy menus). 5 s still
        // covers Next Episode / episode switch, which send the next play within ~1 s.
        private static readonly TimeSpan RestoreDelay = TimeSpan.FromSeconds(5);
        private DispatcherTimer _restoreTimer;
        private HdmiDisplayHdrOption _activeHdr = HdmiDisplayHdrOption.None; // what we last requested
        private bool _wantSdr;          // current playback has hdr=off
        private int _sdrReasserts;
        private bool _hdmiHooked;
        private HdmiDisplayMode _chosenMode;  // the SDR mode we picked; the system may swap in a BT.2020 variant

        private static bool IsHdrRange(string range) =>
            range.StartsWith("HDR", StringComparison.Ordinal) || range == "HLG"
            || (range.StartsWith("DOVI", StringComparison.Ordinal) && range != "DOVIWithSDR");

        private static string ModeText(HdmiDisplayMode m) =>
            m == null ? "?" : $"{m.ResolutionWidthInRawPixels}x{m.ResolutionHeightInRawPixels}@{m.RefreshRate:0.###}";

        private static string ModeDetail(HdmiDisplayMode m) =>
            m == null ? "?" : $"{ModeText(m)} cs={m.ColorSpace} enc={m.PixelEncoding} bpp={m.BitsPerPixel} sdrLum={m.IsSdrLuminanceSupported} st2084={m.IsSmpte2084Supported} 2086={m.Is2086MetadataSupported}";

        private static string OutputKind()
        {
            try
            {
                return Windows.Graphics.Display.DisplayInformation.GetForCurrentView().GetAdvancedColorInfo().CurrentAdvancedColorKind.ToString();
            }
            catch
            {
                return "?";
            }
        }

        private static bool OutputIsHdr() => OutputKind() == "HighDynamicRange";

        private void HookHdmiEvents(HdmiDisplayInformation hdmi)
        {
            if (_hdmiHooked)
            {
                return;
            }

            _hdmiHooked = true;
            hdmi.DisplayModesChanged += (s, a) => RunOnUiFireAndForget(() => NativeLog($"display: event modesChanged now={ModeText(s.GetCurrentDisplayMode())} {OutputKind()}"));
            try
            {
                Windows.Graphics.Display.DisplayInformation.GetForCurrentView().AdvancedColorInfoChanged += (s, a) =>
                    RunOnUiFireAndForget(async () =>
                    {
                        NativeLog($"display: event advancedColorChanged now={OutputKind()} playing={_playing} wantSdr={_wantSdr}");
                        await EnforceSdrAsync("advancedColorChanged");
                    });
            }
            catch (Exception ex)
            {
                NativeLog("display: AdvancedColorInfoChanged hook failed " + ex.Message);
            }
        }

        /// <summary>hdr=off watchdog: if the output went HDR anyway, request the current mode again with EotfSdr.</summary>
        private async Task EnforceSdrAsync(string why)
        {
            if (!_playing || !_wantSdr || !OutputIsHdr() || _sdrReasserts >= 2)
            {
                return;
            }

            _sdrReasserts++;
            var hdmi = HdmiDisplayInformation.GetForCurrentView();
            var cur = hdmi?.GetCurrentDisplayMode();
            var target = _chosenMode ?? cur;
            if (target == null)
            {
                return;
            }

            var ok = false;
            try
            {
                ok = await hdmi.RequestSetCurrentDisplayModeAsync(target, target.IsSdrLuminanceSupported ? HdmiDisplayHdrOption.EotfSdr : HdmiDisplayHdrOption.None);
            }
            catch (Exception ex)
            {
                NativeLog($"display: reassert failed 0x{ex.HResult:X8}");
            }

            _activeHdr = HdmiDisplayHdrOption.EotfSdr;
            NativeLog($"display: switch reassert-sdr ({why}) was {ModeDetail(cur)} -> {ModeDetail(target)} ok={ok} now={OutputKind()} cur={ModeDetail(hdmi.GetCurrentDisplayMode())}");
        }

        /// <summary>Logs the real output state ~3 s into playback (ground truth beyond what the request returned).</summary>
        private async void ProbeDisplayLater(int playToken)
        {
            await Task.Delay(3000);
            if (!_playing || playToken != _playToken)
            {
                return;
            }

            var hdmi = HdmiDisplayInformation.GetForCurrentView();
            NativeLog($"display: probe+3s {ModeDetail(hdmi?.GetCurrentDisplayMode())} output={OutputKind()} requested={_activeHdr} wantSdr={_wantSdr}");
            await EnforceSdrAsync("probe");
        }

        private int _playToken;

        private async Task<string> SwitchDisplayModeAsync(JsonObject msg)
        {
            CancelDeferredRestore();
            var hdmi = HdmiDisplayInformation.GetForCurrentView();
            if (hdmi == null)
            {
                return "keep (no HDMI info, not an Xbox?)";
            }

            HookHdmiEvents(hdmi);
            var width = (uint)msg.GetNamedNumber("width", 3840);
            var height = (uint)msg.GetNamedNumber("height", 2160);
            var fps = msg.GetNamedNumber("fps", 23.976);
            var range = msg.GetNamedString("videoRangeType", "SDR");
            var hdrSetting = msg.GetNamedString("hdr", "off");
            var matchFps = msg.GetNamedBoolean("matchFrameRate", true);

            var cur = hdmi.GetCurrentDisplayMode();
            var outputIsHdr = OutputIsHdr();
            var before = $"{ModeText(cur)} cs={cur?.ColorSpace} bpp={cur?.BitsPerPixel} {OutputKind()}";
            var modes = hdmi.GetSupportedDisplayModes().Where(m => !m.StereoEnabled).ToList();

            // SDR is explicit (EotfSdr); None = "no preference" and lets HDR10 frames flip the TV to HDR.
            var sdrOption = HdmiDisplayHdrOption.EotfSdr;
            var hdr = sdrOption;
            if (hdrSetting == "auto" && IsHdrRange(range))
            {
                if (range == "DOVI" && modes.Any(m => m.IsDolbyVisionLowLatencySupported))
                {
                    hdr = HdmiDisplayHdrOption.DolbyVisionLowLatency;
                }
                else if (modes.Any(m => m.IsSmpte2084Supported))
                {
                    hdr = HdmiDisplayHdrOption.Eotf2084;
                }
            }

            var wantHdr = hdr == HdmiDisplayHdrOption.Eotf2084 || hdr == HdmiDisplayHdrOption.DolbyVisionLowLatency;
            _wantSdr = !wantHdr;
            _sdrReasserts = 0;
            var tag = $"(hdr={hdrSetting} range={range} content={width}x{height}@{fps:0.###})";

            IEnumerable<HdmiDisplayMode> candidates = modes.Where(m =>
                !wantHdr || // any mode carries SDR (1080p modes report IsSdrLuminanceSupported=false)
                (hdr == HdmiDisplayHdrOption.Eotf2084 && m.IsSmpte2084Supported) ||
                (hdr == HdmiDisplayHdrOption.DolbyVisionLowLatency && m.IsDolbyVisionLowLatencySupported));

            // Content <= 1080 lines on a 1080p output: keep the resolution, only (maybe) change the refresh rate.
            var keepRes = cur != null && height <= 1080 && cur.ResolutionHeightInRawPixels == 1080;
            if (keepRes || !matchFps)
            {
                var curRes = candidates.Where(m => cur != null && m.ResolutionWidthInRawPixels == cur.ResolutionWidthInRawPixels && m.ResolutionHeightInRawPixels == cur.ResolutionHeightInRawPixels).ToList();
                if (curRes.Count > 0 && (keepRes || !wantHdr))
                {
                    candidates = curRes;
                }
            }
            else
            {
                var sameRes = candidates.Where(m => m.ResolutionWidthInRawPixels == width || m.ResolutionHeightInRawPixels == height).ToList();
                if (sameRes.Count > 0)
                {
                    candidates = sameRes;
                }
            }

            var targetFps = matchFps ? fps : cur?.RefreshRate ?? 60;
            var ordered = candidates
                .OrderBy(m => Math.Abs(m.RefreshRate - targetFps) <= 0.01 ? 0 : Math.Abs(m.RefreshRate - targetFps) <= 0.5 ? 1 : 2)
                .ThenBy(m => Math.Abs(m.RefreshRate - targetFps))
                // Same res/rate comes in several variants. For SDR pick the plain one: an ST2084-capable BT.2020 10-bit
                // variant keeps the link in BT.2020 colorimetry even with EotfSdr, and the TV badges that as "HDR".
                .ThenBy(m => wantHdr ? 0 : (m.IsSmpte2084Supported ? 1 : 0) + (m.ColorSpace == HdmiDisplayColorSpace.BT709 ? 0 : 2))
                .ThenBy(m => wantHdr ? -(int)m.BitsPerPixel : (int)m.BitsPerPixel)
                .ToList();
            var bestRate = ordered.FirstOrDefault();
            if (bestRate != null)
            {
                NativeLog("display: variants " + string.Join(" | ", ordered.Where(m => m.ResolutionWidthInRawPixels == bestRate.ResolutionWidthInRawPixels && Math.Abs(m.RefreshRate - bestRate.RefreshRate) <= 0.01).Select(ModeDetail)));
            }

            if (ordered.Count == 0)
            {
                return $"keep {before} (no candidate mode) {tag}";
            }

            var best = ordered[0];
            var sameMode = cur != null && best.ResolutionWidthInRawPixels == cur.ResolutionWidthInRawPixels
                && best.ResolutionHeightInRawPixels == cur.ResolutionHeightInRawPixels
                && Math.Abs(best.RefreshRate - cur.RefreshRate) <= 0.01
                && best.ColorSpace == cur.ColorSpace && best.BitsPerPixel == cur.BitsPerPixel;
            // HDR state matches when the output kind matches and, for SDR, we already asked for the explicit SDR EOTF
            // (HDR content on a mode not pinned with EotfSdr may drift to HDR, so pin it once).
            var sameHdr = wantHdr ? outputIsHdr : (!outputIsHdr && (_activeHdr == hdr || !cur.IsSdrLuminanceSupported || !IsHdrRange(range)));
            if (sameMode && sameHdr)
            {
                _chosenMode = wantHdr ? null : cur;
                return $"keep {before} (already {ModeText(best)} {hdr}) {tag}";
            }

            foreach (var m in ordered.Take(4))
            {
                // EotfSdr is only valid on modes that advertise SDR luminance (10-bit / HDR-capable links). 8-bit RGB
                // modes (e.g. 1080p@23.976 here) reject it with E_INVALIDARG; they can't carry HDR, so None is safe there.
                var opt = wantHdr || m.IsSdrLuminanceSupported ? hdr : HdmiDisplayHdrOption.None;
                try
                {
                    if (await hdmi.RequestSetCurrentDisplayModeAsync(m, opt))
                    {
                        _modeSwitched = true;
                        _activeHdr = opt;
                        _chosenMode = wantHdr ? null : m;
                        return $"switch {before} -> {ModeText(m)} cs={m.ColorSpace} bpp={m.BitsPerPixel} {opt} {tag} now={OutputKind()}";
                    }
                }
                catch (Exception ex)
                {
                    NativeLog($"display: request {ModeText(m)} {opt} failed 0x{ex.HResult:X8}");
                }
            }

            return $"keep {before} (switch refused for {hdr}) {tag}";
        }

        private void CancelDeferredRestore()
        {
            if (_restoreTimer != null && _restoreTimer.IsEnabled)
            {
                _restoreTimer.Stop();
                NativeLog("display: restore-cancelled (new play)");
            }
        }

        /// <summary>After stop: keep the playback mode while browsing; restore after 5 s idle.</summary>
        private void ScheduleDeferredRestore()
        {
            if (!_modeSwitched)
            {
                return;
            }

            if (_restoreTimer == null)
            {
                _restoreTimer = new DispatcherTimer { Interval = RestoreDelay };
                _restoreTimer.Tick += async (s, e) =>
                {
                    _restoreTimer.Stop();
                    if (!_playing)
                    {
                        await RestoreDisplayModeAsync("idle");
                    }
                };
            }

            _restoreTimer.Stop();
            _restoreTimer.Start();
            var hdmi = HdmiDisplayInformation.GetForCurrentView();
            NativeLog($"display: restore-deferred {RestoreDelay.TotalSeconds:0}s (keeping {ModeText(hdmi?.GetCurrentDisplayMode())} {OutputKind()})");
        }

        /// <summary>Restore the user's default mode now (idle timeout, exit, suspend).</summary>
        public async Task RestoreDisplayModeAsync(string why)
        {
            _restoreTimer?.Stop();
            if (!_modeSwitched)
            {
                return;
            }

            _modeSwitched = false;
            _activeHdr = HdmiDisplayHdrOption.None;
            _chosenMode = null;
            var hdmi = HdmiDisplayInformation.GetForCurrentView();
            if (hdmi != null)
            {
                await hdmi.SetDefaultDisplayModeAsync();
                NativeLog($"display: restore ({why}) -> {ModeText(hdmi.GetCurrentDisplayMode())} {OutputKind()}");
            }
        }

        // ---------- capabilities (probed on the device) ----------

        private static readonly Dictionary<string, string> VideoNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["H264"] = "h264", ["AVC1"] = "h264", ["HEVC"] = "hevc", ["HEV1"] = "hevc", ["HVC1"] = "hevc",
            ["AV01"] = "av1", ["VP90"] = "vp9", ["VP80"] = "vp8", ["MPG2"] = "mpeg2video", ["MP4V"] = "mpeg4",
            ["WVC1"] = "vc1", ["MJPG"] = "mjpeg",
        };

        private static readonly Dictionary<string, string> AudioGuidNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["e06d802c-db46-11cf-b4d1-00805f6cbbea"] = "ac3",
            ["a7fb87af-2d02-42fb-a4d4-05cd93843bdd"] = "eac3",
            ["0000f1ac-0000-0010-8000-00aa00389b71"] = "flac",
            ["0000704f-0000-0010-8000-00aa00389b71"] = "opus",
            ["00006c61-0000-0010-8000-00aa00389b71"] = "alac",
            ["00001610-0000-0010-8000-00aa00389b71"] = "aac",
            ["00001600-0000-0010-8000-00aa00389b71"] = "aac",
            ["00000055-0000-0010-8000-00aa00389b71"] = "mp3",
            ["00000050-0000-0010-8000-00aa00389b71"] = "mp2",
            ["00000001-0000-0010-8000-00aa00389b71"] = "pcm",
            ["00000003-0000-0010-8000-00aa00389b71"] = "pcm_float",
            ["00000008-0000-0010-8000-00aa00389b71"] = "dts",
            ["00002000-0000-0010-8000-00aa00389b71"] = "ac3",
            ["00000092-0000-0010-8000-00aa00389b71"] = "ac3",
            ["00000161-0000-0010-8000-00aa00389b71"] = "wmav2",
            ["00000162-0000-0010-8000-00aa00389b71"] = "wmapro",
            ["00000163-0000-0010-8000-00aa00389b71"] = "wmalossless",
            ["0000ac40-0000-0010-8000-00aa00389b71"] = "ac4",
        };

        private static string Norm(string subtype) => (subtype ?? string.Empty).Trim('{', '}').ToLowerInvariant();

        private static string VideoSubtypeName(string subtype)
        {
            var s = Norm(subtype);
            if (VideoNames.TryGetValue(s, out var n))
            {
                return n;
            }

            // FourCC GUID: first DWORD little-endian chars.
            if (s.Length == 36 && s.EndsWith("-0000-0010-8000-00aa00389b71", StringComparison.Ordinal) && uint.TryParse(s.Substring(0, 8), System.Globalization.NumberStyles.HexNumber, null, out var fcc) && fcc > 0xFFFF)
            {
                var cc = new string(new[] { (char)(fcc & 0xFF), (char)((fcc >> 8) & 0xFF), (char)((fcc >> 16) & 0xFF), (char)(fcc >> 24) });
                return VideoNames.TryGetValue(cc, out var n2) ? n2 : cc;
            }

            return subtype;
        }

        private static string AudioSubtypeName(string subtype)
        {
            var s = Norm(subtype);
            if (AudioGuidNames.TryGetValue(s, out var n))
            {
                return n;
            }

            switch (s)
            {
                case "aac": case "mpeg4aac": return "aac";
                case "mp3": return "mp3";
                case "ac3": return "ac3";
                case "eac3": return "eac3";
                case "flac": return "flac";
                case "pcm": return "pcm";
                case "float": return "pcm_float";
                case "alac": return "alac";
                case "opus": return "opus";
            }

            return subtype;
        }


        // name -> MF subtype for per-subtype CodecQuery probes. Enumerating everything (empty subtype) hard-crashed
        // the app on Xbox, so probe one subtype at a time, off the UI thread, with a crash guard in LocalSettings.
        private static readonly (string Name, bool Video, string Subtype)[] Probes =
        {
            ("h264", true, CodecSubtypes.VideoFormatH264),
            ("hevc", true, CodecSubtypes.VideoFormatHevc),
            ("av1", true, "{31305641-0000-0010-8000-00AA00389B71}"),
            ("vp9", true, CodecSubtypes.VideoFormatVP90),
            ("vp8", true, CodecSubtypes.VideoFormatVP80),
            ("mpeg2video", true, CodecSubtypes.VideoFormatMpeg2),
            ("vc1", true, CodecSubtypes.VideoFormatWvc1),
            ("aac", false, CodecSubtypes.AudioFormatAac),
            ("ac3", false, CodecSubtypes.AudioFormatDolbyAC3),
            ("eac3", false, CodecSubtypes.AudioFormatDolbyDDPlus),
            ("flac", false, CodecSubtypes.AudioFormatFlac),
            ("mp3", false, CodecSubtypes.AudioFormatMP3),
            ("opus", false, CodecSubtypes.AudioFormatOpus),
            ("alac", false, CodecSubtypes.AudioFormatAlac),
            ("dts", false, CodecSubtypes.AudioFormatDts),
            ("ac4", false, "{0000AC40-0000-0010-8000-00AA00389B71}"),
            ("pcm", false, CodecSubtypes.AudioFormatPcm),
        };

        private static async Task ProbeCodecsAsync(SortedSet<string> video, SortedSet<string> audio, System.Text.StringBuilder raw)
        {
            var settings = Windows.Storage.ApplicationData.Current.LocalSettings.Values;

            // A leftover "probing" mark also appears when the app is merely killed mid-probe (Portal relaunch, user
            // quitting during startup), not only on a real crash. So: forget the blacklist on every new app version,
            // only blacklist a codec after it was the in-flight probe on 2 consecutive launches, and never blacklist
            // the codecs every Xbox decodes in hardware (dropping them forces 4K transcodes).
            var ver = Windows.ApplicationModel.Package.Current.Id.Version;
            var verStr = $"{ver.Major}.{ver.Minor}.{ver.Build}.{ver.Revision}";
            if (settings["probeVersion"] as string != verStr)
            {
                settings["probeVersion"] = verStr;
                settings["probeCrashed"] = string.Empty;
                settings["probeSuspect"] = string.Empty;
            }

            var crashed = settings["probeCrashed"] as string ?? string.Empty;
            if (settings["probing"] is string last && last.Length > 0)
            {
                settings["probing"] = string.Empty;
                var protectedKey = last == "v:h264" || last == "v:hevc" || last == "a:aac" || last == "a:ac3";
                if (!protectedKey && settings["probeSuspect"] as string == last)
                {
                    crashed = crashed + "," + last;
                    settings["probeCrashed"] = crashed;
                    settings["probeSuspect"] = string.Empty;
                    NativeLog("codec probe '" + last + "' died on 2 launches in a row; skipping it");
                }
                else
                {
                    settings["probeSuspect"] = last;
                    NativeLog("codec probe '" + last + "' was interrupted last launch; retrying once");
                }
            }
            else
            {
                settings["probeSuspect"] = string.Empty;
            }

            var q = new CodecQuery();
            foreach (var (name, isVideo, subtype) in Probes)
            {
                var key = (isVideo ? "v:" : "a:") + name;
                if (crashed.Contains(key))
                {
                    raw.Append($" {key}=CRASHED");
                    continue;
                }

                settings["probing"] = key;
                try
                {
                    var found = await Task.Run(async () =>
                        await q.FindAllAsync(isVideo ? CodecKind.Video : CodecKind.Audio, CodecCategory.Decoder, subtype));
                    var names = string.Join("/", found.Select(c => c.DisplayName));
                    raw.Append($" {key}={found.Count}[{names}]");
                    if (found.Count > 0)
                    {
                        (isVideo ? video : audio).Add(name);
                    }
                }
                catch (Exception ex)
                {
                    raw.Append($" {key}=ERR(0x{ex.HResult:X8})");
                }

                settings["probing"] = string.Empty;
            }
        }

        private async Task<JsonObject> BuildCapabilitiesAsync()
        {
            var caps = new JsonObject
            {
                ["deviceForm"] = JsonValue.CreateStringValue(Windows.System.Profile.AnalyticsInfo.DeviceForm),
                ["deviceFamily"] = JsonValue.CreateStringValue(Windows.System.Profile.AnalyticsInfo.VersionInfo.DeviceFamily),
            };

            var hdmi = HdmiDisplayInformation.GetForCurrentView();
            var hdrDisplay = false;
            if (hdmi != null)
            {
                var modes = hdmi.GetSupportedDisplayModes().Where(m => !m.StereoEnabled).ToList();
                hdrDisplay = modes.Any(m => m.IsSmpte2084Supported);
                caps["dolbyVisionLL"] = JsonValue.CreateBooleanValue(modes.Any(m => m.IsDolbyVisionLowLatencySupported));
                caps["currentMode"] = JsonValue.CreateStringValue(ModeText(hdmi.GetCurrentDisplayMode()));
                caps["outputKind"] = JsonValue.CreateStringValue(OutputKind());
                var arr = new JsonArray();
                foreach (var m in modes.OrderByDescending(m => m.ResolutionHeightInRawPixels).ThenBy(m => m.RefreshRate))
                {
                    arr.Add(JsonValue.CreateStringValue($"{ModeText(m)}{(m.IsSmpte2084Supported ? " HDR" : string.Empty)}{(m.IsDolbyVisionLowLatencySupported ? " DV-LL" : string.Empty)}"));
                }

                caps["modes"] = arr;
            }

            caps["hdrDisplay"] = JsonValue.CreateBooleanValue(hdrDisplay);
            caps["pip"] = JsonValue.CreateBooleanValue(true); // setVideoRect (VideoRect.cs)
            caps["pipSubs"] = JsonValue.CreateBooleanValue(true); // setPipSubs + setVideoRect anim (VideoRect.cs)

            var video = new SortedSet<string>();
            var audio = new SortedSet<string>();
            var raw = new System.Text.StringBuilder("CODECQUERY");
            await ProbeCodecsAsync(video, audio, raw);
            NativeLog(raw.ToString());

            var va = new JsonArray();
            foreach (var v in video)
            {
                va.Add(JsonValue.CreateStringValue(v));
            }

            var aa = new JsonArray();
            foreach (var a in audio)
            {
                aa.Add(JsonValue.CreateStringValue(a));
            }

            var fa = new JsonArray();
            foreach (var a in FfmpegAudio)
            {
                fa.Add(JsonValue.CreateStringValue(a));
            }

            var containers = new JsonArray();
            foreach (var c in new[] { "mkv", "mp4", "m4v", "mov", "ts", "webm", "hls" })
            {
                containers.Add(JsonValue.CreateStringValue(c));
            }

            caps["video"] = va;
            caps["audioNative"] = aa;
            caps["audioFfmpeg"] = fa;
            caps["containers"] = containers;
            caps["maxAudioChannels"] = JsonValue.CreateNumberValue(8);
            caps["bridgeVersion"] = JsonValue.CreateNumberValue(1);
            return caps;
        }

        // ---------- helpers ----------

        private void ShowFatal(string text)
        {
            Root.Children.Add(new TextBlock { Text = text, Margin = new Thickness(96), FontSize = 32, TextWrapping = TextWrapping.Wrap });
        }

        private void RunOnUiFireAndForget(Action action)
        {
            _ = Dispatcher.RunAsync(CoreDispatcherPriority.Normal, () =>
            {
                try
                {
                    action();
                }
                catch (Exception ex)
                {
                    NativeLog("ui action failed: " + ex);
                }
            });
        }

        private void RunOnUiFireAndForget(Func<Task> action)
        {
            _ = Dispatcher.RunAsync(CoreDispatcherPriority.Normal, async () =>
            {
                try
                {
                    await action();
                }
                catch (Exception ex)
                {
                    NativeLog("ui action failed: " + ex);
                }
            });
        }
    }
}
