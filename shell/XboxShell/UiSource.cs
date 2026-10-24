using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Windows.Web.Http;
using Windows.Web.Http.Filters;

namespace XboxShell
{
    /// <summary>
    /// Per-side UI source resolution (docs/store-release.md "UI source order"). No addresses are hard-coded:
    /// media: page server saved by the user (LocalSettings, bridge setUiServer) → build-time media default → build-time
    ///        public default → bundled web/dist via a WebView2 virtual host.
    /// dash:  saved → build-time default → none (the dash side is unavailable).
    /// Build-time defaults come from BuildDefaults (generated from JELLYSHELL_MEDIA_URL / JELLYSHELL_DASH_URL /
    /// JELLYSHELL_PUBLIC_URL at build time, empty in a plain local build; see XboxShell.csproj and docs/building.md).
    /// </summary>
    public static class UiSource
    {
        public const string Media = "media";
        public const string Dash = "dash";

        public const string BundledHost = "app.jellyshell";
        // http, not https: an https page cannot fetch the LAN Jellyfin (http://...:8096, mixed content). The mapping serves both schemes.
        public static readonly Uri Bundled = new Uri("http://" + BundledHost + "/index.html");

        // Plain http (LAN page server) gets the short probe; https (public reverse proxy / funnel) the longer one.
        private const int LanTimeoutMs = 2500;
        private const int PublicTimeoutMs = 4000;

        private static readonly HttpClient Probe = MakeProbeClient();

        private static HttpClient MakeProbeClient()
        {
            var f = new HttpBaseProtocolFilter();
            f.CacheControl.ReadBehavior = HttpCacheReadBehavior.MostRecent;
            f.CacheControl.WriteBehavior = HttpCacheWriteBehavior.NoCache;
            return new HttpClient(f);
        }

        /// <summary>Folder holding the packaged web/dist copy (CI copies it into the ui/ content folder).</summary>
        public static string BundledFolder =>
            Path.Combine(Windows.ApplicationModel.Package.Current.InstalledLocation.Path, "ui");

        public static bool HasBundle
        {
            get
            {
                try
                {
                    return File.Exists(Path.Combine(BundledFolder, "index.html"));
                }
                catch
                {
                    return false;
                }
            }
        }

        // ---------- configured addresses ----------

        /// <summary>
        /// Normalizes a page-server address: absolute http(s), no credentials, query or fragment, path ending in "/"
        /// (so relative "log" / "api/config" stay under a sub-path like /jellyshell/). null when it isn't usable.
        /// </summary>
        public static Uri ParseServerUrl(string s)
        {
            if (string.IsNullOrWhiteSpace(s))
            {
                return null;
            }

            Uri u;
            if (!Uri.TryCreate(s.Trim(), UriKind.Absolute, out u))
            {
                return null;
            }

            if ((u.Scheme != "http" && u.Scheme != "https") || string.IsNullOrEmpty(u.Host) || !string.IsNullOrEmpty(u.UserInfo))
            {
                return null;
            }

            var left = u.GetLeftPart(UriPartial.Path);
            if (!left.EndsWith("/", StringComparison.Ordinal))
            {
                left += "/";
            }

            return new Uri(left);
        }

        private static string SavedKey(string side) => "uiServer." + side;

        /// <summary>The address the user saved for a side (bridge setUiServer), or null.</summary>
        public static Uri Saved(string side)
        {
            try
            {
                return ParseServerUrl(Windows.Storage.ApplicationData.Current.LocalSettings.Values[SavedKey(side)] as string);
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Save (url != null) or clear (null) the user's address for a side.</summary>
        public static void SetSaved(string side, Uri url)
        {
            var v = Windows.Storage.ApplicationData.Current.LocalSettings.Values;
            if (url == null)
            {
                v.Remove(SavedKey(side));
            }
            else
            {
                v[SavedKey(side)] = url.ToString();
            }
        }

        /// <summary>Build-time default for a side (null when the build had none).</summary>
        public static Uri BuildDefault(string side) => ParseServerUrl(side == Dash ? BuildDefaults.DashUrl : BuildDefaults.MediaUrl);

        public static Uri BuildPublic => ParseServerUrl(BuildDefaults.PublicUrl);

        /// <summary>Media candidates in resolution order, each with its source label.</summary>
        private static List<KeyValuePair<string, Uri>> MediaCandidates()
        {
            var list = new List<KeyValuePair<string, Uri>>();
            Add(list, "saved", Saved(Media));
            Add(list, "default", BuildDefault(Media));
            Add(list, "public", BuildPublic);
            return list;
        }

        private static List<KeyValuePair<string, Uri>> DashCandidates()
        {
            var list = new List<KeyValuePair<string, Uri>>();
            Add(list, "saved", Saved(Dash));
            Add(list, "default", BuildDefault(Dash));
            return list;
        }

        private static void Add(List<KeyValuePair<string, Uri>> list, string source, Uri url)
        {
            if (url == null)
            {
                return;
            }

            foreach (var c in list)
            {
                if (c.Value == url)
                {
                    return; // same address twice (e.g. saved = build default): probe it once
                }
            }

            list.Add(new KeyValuePair<string, Uri>(source, url));
        }

        /// <summary>First configured media page server, before any probe (early native log lines go there).</summary>
        public static Uri FirstMediaCandidate
        {
            get
            {
                var c = MediaCandidates();
                return c.Count > 0 ? c[0].Value : null;
            }
        }

        // ---------- probing ----------

        public static async Task<bool> ProbeAsync(Uri url, int timeoutMs)
        {
            using (var cts = new CancellationTokenSource(timeoutMs))
            {
                try
                {
                    using (var r = await Probe.GetAsync(url, HttpCompletionOption.ResponseHeadersRead).AsTask(cts.Token))
                    {
                        return r.IsSuccessStatusCode;
                    }
                }
                catch
                {
                    return false;
                }
            }
        }

        public static Task<bool> ProbeAsync(Uri url) => ProbeAsync(url, url.Scheme == "https" ? PublicTimeoutMs : LanTimeoutMs);

        public sealed class Resolved
        {
            public string Side;
            public Uri Url;
            public string Source;   // "saved" | "default" | "public" | "bundled" | "none"

            /// <summary>Where native log lines go (the resolved media page server); null = bundled / none, drop logs.</summary>
            public Uri LogBase;
        }

        /// <summary>Resolve media: the first reachable candidate, else the bundled UI.</summary>
        public static async Task<Resolved> ResolveMediaAsync()
        {
            var candidates = MediaCandidates();
            foreach (var c in candidates)
            {
                if (await ProbeAsync(c.Value))
                {
                    return new Resolved { Side = Media, Url = c.Value, Source = c.Key, LogBase = c.Value };
                }
            }

            if (HasBundle)
            {
                return new Resolved { Side = Media, Url = Bundled, Source = "bundled", LogBase = null };
            }

            // Nothing reachable and no bundle (local build without web/dist in ui\): show the first configured address so the
            // WebView error is at least explicit; with nothing configured either, MainPage shows a message instead.
            return candidates.Count > 0
                ? new Resolved { Side = Media, Url = candidates[0].Value, Source = candidates[0].Key, LogBase = candidates[0].Value }
                : new Resolved { Side = Media, Url = null, Source = "none", LogBase = null };
        }

        /// <summary>Dash: the first reachable candidate, null when none is configured or reachable.</summary>
        public static async Task<Resolved> ResolveDashAsync()
        {
            foreach (var c in DashCandidates())
            {
                if (await ProbeAsync(c.Value))
                {
                    return new Resolved { Side = Dash, Url = c.Value, Source = c.Key, LogBase = null };
                }
            }

            return null;
        }

        // ---------- start side (LocalSettings) ----------

        public static string StartSide
        {
            get
            {
                var v = Windows.Storage.ApplicationData.Current.LocalSettings.Values["startSide"] as string;
                return v == Dash ? Dash : Media;
            }

            set
            {
                Windows.Storage.ApplicationData.Current.LocalSettings.Values["startSide"] = value == Dash ? Dash : Media;
            }
        }

        public static bool IsSide(string s) => s == Media || s == Dash;
    }
}
