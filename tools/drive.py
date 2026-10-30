"""Debug test driver for the JellyShell bridge (docs/bridge.md) via the page server's /api/cmd queue
(page server started with JELLYSHELL_DEBUG=1; config via env / repo-root .env, see tools/toolenv.py).

  python3 tools/drive.py shot NAME                     -> web-poc/snaps/portal-NAME.png (Device Portal)
  python3 tools/drive.py jf ITEM VARIANT [k=v ...]     -> queue a full bridge `play` built from Jellyfin
        VARIANT: direct | mkv-eac3 | mp4-aac | mp4-eac3 | hls-mp4 | hls-ts  (remux/transcode URLs)
        k=v overrides play fields (hdr=auto, matchFrameRate=false, engine=ffmpeg, startMs=60000 ...)
  python3 tools/drive.py send '{"type":"seek","positionMs":60000}'   -> any bridge message
  python3 tools/drive.py stop | pause | resume | seek MS | audio IDX | volume V
  python3 tools/drive.py nav URL                        -> page navigates (e.g. /overlay-test.html)
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import deploy  # noqa: E402
import toolenv  # noqa: E402

POC = toolenv.page_url()
JF_LOCAL = toolenv.jellyfin_url()  # how this machine reaches Jellyfin (item lookups)
JF_LAN = toolenv.jellyfin_client_url()  # how the console reaches Jellyfin (stream URLs)
SNAPS = Path(__file__).resolve().parent.parent / 'web-poc' / 'snaps'


def cmd(obj):
    req = urllib.request.Request(POC + '/api/cmd', json.dumps(obj).encode(), method='POST')
    urllib.request.urlopen(req, timeout=5).read()


def send(msg):
    cmd({'send': msg})


def shot(name):
    p = deploy.Portal()
    p.call('GET', '/api/os/info')
    code, png = p.call('GET', '/ext/screenshot?download=true&hdr=false')
    SNAPS.mkdir(exist_ok=True)
    out = SNAPS / f'portal-{name}.png'
    out.write_bytes(png)
    print('screenshot', code, out, len(png))


def jf_cfg():
    key, uid = toolenv.jellyfin_key()
    return {'key': key, 'userId': uid}


def jf_play(item_id, variant, overrides):
    c = jf_cfg()
    req = urllib.request.Request(f"{JF_LOCAL}/Users/{c['userId']}/Items/{item_id}", headers={'Authorization': f'MediaBrowser Token="{c["key"]}"'})
    it = json.load(urllib.request.urlopen(req, timeout=10))
    ms = it['MediaSources'][0]
    v = next(s for s in ms['MediaStreams'] if s['Type'] == 'Video')
    a = next((s for s in ms['MediaStreams'] if s['Type'] == 'Audio'), {})
    base = f"{JF_LAN}/Videos/{item_id}"
    common = f"mediaSourceId={ms['Id']}&ApiKey={c['key']}&playSessionId=drive{int(time.time())}&deviceId=jellyshell-drive"
    container, acodec = ms['Container'], a.get('Codec', '')
    vc = v.get('Codec', '')
    if variant == 'direct':
        url = f"{base}/stream?static=true&{common}"
    elif variant in ('mkv-eac3', 'mp4-aac', 'mp4-eac3'):
        container, acodec = variant.split('-')
        url = (f"{base}/stream.{container}?container={container}&videoCodec={vc}&audioCodec={acodec}"
               f"&audioChannels=6&audioBitRate=640000&allowVideoStreamCopy=true&{common}")
    elif variant in ('hls-mp4', 'hls-ts', 'hls-h264', 'hls-hevc'):
        seg = 'ts' if variant == 'hls-ts' else 'mp4'
        acodec = 'eac3' if seg == 'mp4' else 'ac3'
        container = 'hls'
        venc = {'hls-h264': 'h264', 'hls-hevc': 'hevc'}.get(variant)
        scale = (f"&MaxWidth={overrides.pop('maxWidth', '1920')}&VideoBitrate={overrides.pop('videoBitrate', '20000000')}"
                 f"&AllowVideoStreamCopy=false") if venc else '&AllowVideoStreamCopy=true'
        if venc:
            vc = venc
        url = (f"{base}/master.m3u8?VideoCodec={vc}&AudioCodec={acodec}&SegmentContainer={seg}"
               f"{scale}&AllowAudioStreamCopy=false&AudioBitrate=640000&MaxAudioChannels=6"
               f"&TranscodingMaxAudioChannels=6&BreakOnNonKeyFrames=true&{common}")
    else:
        raise SystemExit('unknown variant ' + variant)
    msg = {
        'type': 'play', 'url': url, 'itemId': item_id, 'startMs': 0, 'container': container,
        'videoCodec': vc, 'audioCodec': acodec, 'videoRangeType': v.get('VideoRangeType', 'SDR'),
        'width': v.get('Width', 3840), 'height': v.get('Height', 2160),
        'fps': v.get('RealFrameRate') or v.get('AverageFrameRate') or 23.976,
        'hdr': 'off', 'matchFrameRate': True,
    }
    for k, val in overrides.items():
        msg[k] = json.loads(val) if val in ('true', 'false') or val.lstrip('-').isdigit() else val
    print(it['Name'], variant, {k: msg[k] for k in msg if k != 'url'})
    send(msg)


def main():
    a = sys.argv[1:]
    if a[0] == 'shot':
        shot(a[1])
    elif a[0] == 'stop':
        cmd({'stop': True})
    elif a[0] in ('pause', 'resume'):
        send({'type': a[0]})
    elif a[0] == 'seek':
        send({'type': 'seek', 'positionMs': int(a[1])})
    elif a[0] == 'audio':
        send({'type': 'setAudioTrack', 'index': int(a[1])})
    elif a[0] == 'volume':
        send({'type': 'setVolume', 'value': float(a[1])})
    elif a[0] == 'send':
        send(json.loads(a[1]))
    elif a[0] in ('launch', 'dumps'):
        import base64
        import urllib.parse
        p = deploy.Portal()
        p.call('GET', '/api/os/info')
        if a[0] == 'dumps':
            print(p.call('GET', '/api/debug/dump/usermode/dumps')[1].decode(errors='replace')[:2000])
            return
        pk = next(x for x in json.loads(p.call('GET', '/api/app/packagemanager/packages')[1])['InstalledPackages']
                  if toolenv.env('XBOX_PACKAGE_MATCH', '.JellyShell_') in x['PackageFullName'])
        b64 = lambda s: urllib.parse.quote(base64.b64encode(s.encode()).decode(), safe='')  # noqa: E731
        st, out = p.call('POST', f"/api/taskmanager/app?appid={b64(pk['PackageRelativeId'])}&package={b64(pk['PackageFullName'])}")
        print('launch', pk['PackageFullName'], st, out[:200])
    elif a[0] == 'nav':
        # Native debug message (not bridge v1): WebView navigates; works whatever page is loaded.
        url = a[1] if a[1].startswith('http') else POC + a[1]
        send({'type': 'navigate', 'url': url})
    elif a[0] == 'jf':
        jf_play(a[1], a[2], dict(kv.split('=', 1) for kv in a[3:]))


if __name__ == '__main__':
    main()
