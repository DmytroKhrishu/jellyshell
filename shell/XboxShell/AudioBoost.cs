// Audio boost / night mode (bridge `setAudioBoost {db, night}`, also `audioBoost` inside `play`).
//
// MediaPlayer.Volume caps at 1.0, so a boost needs real DSP. FFmpegInteropX (already used for TrueHD/DTS) runs an
// FFmpeg audio filter graph on its decoded PCM: MediaSourceConfig.Audio.FFmpegAudioFilters at open, and
// FFmpegMediaSource.SetFFmpegAudioFilters / ClearFFmpegAudioFilters live. The bundled avfilter-11 (FFmpegInteropX.UWP.FFmpeg
// 8.1.2) contains volume, acompressor and alimiter. So: while a boost is active, file playback goes through the
// FFmpeg path (video stays on the hardware decoder via ForceSystemDecoder, as for TrueHD); switching boost on during an
// MF playback reopens the same URL on the FFmpeg path at the current position. HLS (transcodes) stays on MF and reports
// applied=false.
using System;
using System.Globalization;
using System.Threading.Tasks;
using Windows.Data.Json;

namespace XboxShell
{
    public sealed partial class MainPage
    {
        private double _boostDb;
        private bool _boostNight;

        private bool BoostActive => _boostDb > 0 || _boostNight;

        private void ReadBoost(JsonObject o)
        {
            if (o == null)
            {
                return;
            }

            _boostDb = Math.Max(0, Math.Min(15, o.GetNamedNumber("db", 0)));
            _boostNight = o.GetNamedBoolean("night", false);
        }

        /// <summary>FFmpeg filter graph for the current boost, or empty for none.</summary>
        private string BoostFilter()
        {
            if (!BoostActive)
            {
                return string.Empty;
            }

            var inv = CultureInfo.InvariantCulture;
            var parts = new System.Collections.Generic.List<string>();
            if (_boostNight)
            {
                // Night mode: compress everything above -30 dBFS 6:1, then +9 dB make-up so dialogue comes up.
                parts.Add("acompressor=threshold=0.0316:ratio=6:attack=5:release=250:makeup=2.8");
            }

            if (_boostDb > 0)
            {
                parts.Add(string.Format(inv, "volume={0:0.##}dB:precision=float", _boostDb));
            }

            // Limiter at -1 dBFS so the boost never clips (level=0: no auto make-up).
            parts.Add("alimiter=limit=0.891:level=0:attack=5:release=50");
            return string.Join(",", parts);
        }

        /// <summary>Called from CreatePlaybackItemAsync before an FFmpeg open.</summary>
        private void ConfigureBoost(FFmpegInteropX.MediaSourceConfig cfg)
        {
            var f = BoostFilter();
            if (f.Length > 0)
            {
                cfg.Audio.FFmpegAudioFilters = f;
            }
        }

        private void SendBoostAck(bool applied, string reason)
        {
            var o = new JsonObject
            {
                ["db"] = JsonValue.CreateNumberValue(_boostDb),
                ["night"] = JsonValue.CreateBooleanValue(_boostNight),
                ["applied"] = JsonValue.CreateBooleanValue(applied),
                ["path"] = JsonValue.CreateStringValue(_path),
                ["filter"] = JsonValue.CreateStringValue(BoostFilter()),
            };
            if (reason != null)
            {
                o["reason"] = JsonValue.CreateStringValue(reason);
            }

            NativeLog($"audio boost db={_boostDb} night={_boostNight} applied={applied} path={_path} filter='{BoostFilter()}'{(reason != null ? " reason=" + reason : string.Empty)}");
            Send("audioBoost", o);
        }

        /// <summary>Ack after a play opened (play message carried audioBoost).</summary>
        private void AckBoostAfterOpen()
        {
            if (!BoostActive)
            {
                return;
            }

            var isHls = (_playMsg?.GetNamedString("url", string.Empty) ?? string.Empty).Contains(".m3u8");
            SendBoostAck(_path == "ffmpeg", _path == "ffmpeg" ? null : isHls ? "hls transcode stays on Media Foundation" : "not on the FFmpeg path");
        }

        private async Task SetAudioBoostAsync(JsonObject msg)
        {
            var wasActive = BoostActive;
            ReadBoost(msg);
            if (!_playing || _playMsg == null)
            {
                SendBoostAck(true, "stored (applies at next play)");
                return;
            }

            _playMsg["audioBoost"] = new JsonObject
            {
                ["db"] = JsonValue.CreateNumberValue(_boostDb),
                ["night"] = JsonValue.CreateBooleanValue(_boostNight),
            };

            if (_path == "ffmpeg" && _ffmpeg != null)
            {
                var f = BoostFilter();
                if (f.Length > 0)
                {
                    _ffmpeg.SetFFmpegAudioFilters(f);
                }
                else
                {
                    _ffmpeg.ClearFFmpegAudioFilters();
                }

                SendBoostAck(true, null);
                return;
            }

            var url = _playMsg.GetNamedString("url", string.Empty);
            if (!BoostActive || wasActive == BoostActive || url.Contains(".m3u8"))
            {
                SendBoostAck(!BoostActive, url.Contains(".m3u8") ? "hls transcode stays on Media Foundation" : null);
                return;
            }

            // MF playback, boost just turned on: reopen through FFmpeg at the current position (same track).
            var pos = _mp.PlaybackSession.Position;
            var track = _item?.AudioTracks.SelectedIndex ?? -1;
            if (track >= 0)
            {
                _playMsg["audioStreamIndex"] = JsonValue.CreateNumberValue(track);
            }

            NativeLog($"audio boost: reopening on FFmpeg at {pos.TotalSeconds:0.0}s");
            _mp.Pause();
            _mp.Source = null;
            _item = null;
            var item = await CreatePlaybackItemAsync(_playMsg, new Uri(url), preferFfmpeg: true);
            if (item == null)
            {
                SendBoostAck(false, "FFmpeg reopen failed");
                return;
            }

            AttachItem(item, pos.TotalMilliseconds);
            SendBoostAck(_path == "ffmpeg", null);
        }
    }
}
