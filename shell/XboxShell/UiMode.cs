using System;
using System.Linq;
using System.Threading.Tasks;
using Windows.Data.Json;
using Windows.Graphics.Display;
using Windows.Graphics.Display.Core;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Media;

namespace XboxShell
{
    /// <summary>
    /// Experiment (hidden): can the browse UI render at 4K? Bridge messages (not in v1):
    ///   {type:"displayProbe"}                    -> native logs + sends displayInfo (DisplayInformation, window, JS dpr/screen)
    ///   {type:"setUiMode", mode:"4k"|"1080p", ss:1|2} -> HDMI output for browsing (persisted in LocalSettings "uiMode");
    ///                                               ss=2 lays the WebView out at 2x and scales the XAML element by 0.5
    ///                                               (supersampling test: does the compositor keep the extra pixels?)
    /// </summary>
    public sealed partial class MainPage
    {
        private const string UiModeKey = "uiMode";
        private int _uiSs = 1;

        private static string UiModeSetting
        {
            get => Windows.Storage.ApplicationData.Current.LocalSettings.Values[UiModeKey] as string ?? "1080p";
            set => Windows.Storage.ApplicationData.Current.LocalSettings.Values[UiModeKey] = value;
        }

        private async Task<JsonObject> DisplayProbeAsync(string why)
        {
            var o = new JsonObject { ["why"] = JsonValue.CreateStringValue(why) };
            try
            {
                var di = DisplayInformation.GetForCurrentView();
                o["rawPixelsPerViewPixel"] = JsonValue.CreateNumberValue(di.RawPixelsPerViewPixel);
                o["resolutionScale"] = JsonValue.CreateStringValue(di.ResolutionScale.ToString());
                o["logicalDpi"] = JsonValue.CreateNumberValue(di.LogicalDpi);
                o["rawDpiX"] = JsonValue.CreateNumberValue(di.RawDpiX);
                o["screenRaw"] = JsonValue.CreateStringValue($"{di.ScreenWidthInRawPixels}x{di.ScreenHeightInRawPixels}");
                o["diag"] = JsonValue.CreateNumberValue(di.DiagonalSizeInInches ?? -1);
            }
            catch (Exception ex)
            {
                o["diError"] = JsonValue.CreateStringValue(ex.Message);
            }

            o["window"] = JsonValue.CreateStringValue($"{Window.Current.Bounds.Width}x{Window.Current.Bounds.Height}");
            o["xamlRoot"] = JsonValue.CreateStringValue($"{Root.ActualWidth}x{Root.ActualHeight} scale={Root.XamlRoot?.RasterizationScale}");
            o["web"] = JsonValue.CreateStringValue($"{_web?.ActualWidth}x{_web?.ActualHeight} ss={_uiSs}");
            var hdmi = HdmiDisplayInformation.GetForCurrentView();
            o["hdmi"] = JsonValue.CreateStringValue(ModeDetail(hdmi?.GetCurrentDisplayMode()));
            o["output"] = JsonValue.CreateStringValue(OutputKind());
            o["uiMode"] = JsonValue.CreateStringValue(UiModeSetting);
            try
            {
                var js = await _web.CoreWebView2.ExecuteScriptAsync(
                    "JSON.stringify({dpr:devicePixelRatio,screen:screen.width+'x'+screen.height,avail:screen.availWidth+'x'+screen.availHeight,inner:innerWidth+'x'+innerHeight,vv:window.visualViewport?visualViewport.width+'x'+visualViewport.height+'@'+visualViewport.scale:null,mq4k:matchMedia('(min-resolution: 2dppx)').matches})");
                o["js"] = JsonValue.CreateStringValue(JsonValue.Parse(js).GetString());
            }
            catch (Exception ex)
            {
                o["jsError"] = JsonValue.CreateStringValue(ex.Message);
            }

            NativeLog("UIMODE probe " + o.Stringify());
            return o;
        }

        private async Task SetUiModeAsync(string mode, int ss)
        {
            var hdmi = HdmiDisplayInformation.GetForCurrentView();
            var cur = hdmi?.GetCurrentDisplayMode();
            NativeLog($"UIMODE set {mode} ss={ss} from {ModeDetail(cur)}");
            UiModeSetting = mode;
            ApplySupersample(ss);
            if (hdmi == null)
            {
                return;
            }

            if (mode == "4k")
            {
                var modes = hdmi.GetSupportedDisplayModes().Where(m => !m.StereoEnabled && m.ResolutionHeightInRawPixels == 2160)
                    .OrderBy(m => Math.Abs(m.RefreshRate - 59.94))
                    .ThenBy(m => (m.IsSmpte2084Supported ? 1 : 0) + (m.ColorSpace == HdmiDisplayColorSpace.BT709 ? 0 : 2))
                    .ThenBy(m => (int)m.BitsPerPixel)
                    .ToList();
                NativeLog("UIMODE 4k candidates " + string.Join(" | ", modes.Take(6).Select(ModeDetail)));
                foreach (var m in modes.Take(4))
                {
                    try
                    {
                        if (await hdmi.RequestSetCurrentDisplayModeAsync(m, m.IsSdrLuminanceSupported ? HdmiDisplayHdrOption.EotfSdr : HdmiDisplayHdrOption.None))
                        {
                            _modeSwitched = true; // suspend/exit restores the console default
                            NativeLog($"UIMODE switched -> {ModeDetail(m)}");
                            break;
                        }
                    }
                    catch (Exception ex)
                    {
                        NativeLog($"UIMODE request {ModeText(m)} failed 0x{ex.HResult:X8}");
                    }
                }
            }
            else
            {
                await hdmi.SetDefaultDisplayModeAsync();
                _modeSwitched = false;
            }

            await Task.Delay(3000);
            Send("displayInfo", await DisplayProbeAsync("after setUiMode " + mode));
        }

        private void ApplySupersample(int ss)
        {
            ss = ss == 2 ? 2 : 1;
            _uiSs = ss;
            if (_web == null)
            {
                return;
            }

            if (ss == 2)
            {
                _web.HorizontalAlignment = HorizontalAlignment.Left;
                _web.VerticalAlignment = VerticalAlignment.Top;
                _web.Width = Window.Current.Bounds.Width * 2;
                _web.Height = Window.Current.Bounds.Height * 2;
                _web.RenderTransform = new ScaleTransform { ScaleX = 0.5, ScaleY = 0.5 };
                _ = _web.CoreWebView2?.ExecuteScriptAsync("document.documentElement.style.zoom='2'");
            }
            else
            {
                _web.HorizontalAlignment = HorizontalAlignment.Stretch;
                _web.VerticalAlignment = VerticalAlignment.Stretch;
                _web.Width = double.NaN;
                _web.Height = double.NaN;
                _web.RenderTransform = null;
                _ = _web.CoreWebView2?.ExecuteScriptAsync("document.documentElement.style.zoom=''");
            }
        }
    }
}
