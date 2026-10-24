"""HomePod / Apple TV "Now Playing" sidecar for the JellyShell Dash (optional).

Needs pyatv + aiohttp (dash/server/requirements-nowplaying.txt): run it from a venv
(`.venv-atv/bin/python server/nowplaying.py`, see dash/deploy/) or as the `nowplaying` compose service.
Keeps one connection to the device (found by identifier, so a DHCP move just means a rescan), listens for
push updates, and serves the latest state on NP_BIND:NP_PORT (default 127.0.0.1:8102) that server.py proxies:

  GET  /state     -> JSON (always 200; `available: false` when the HomePod can't be reached)
  GET  /artwork   -> current artwork bytes (404 when none)
  POST /cmd       -> {"action": "play_pause|next|previous|volume_up|volume_down"}

On HomePod pyatv speaks MRP tunnelled over AirPlay: metadata, push updates and remote control work
without pairing/credentials.

Config (env or the repo-root .env):
  NP_DEVICE_ID    required: the device identifier (MAC-style id from `atvremote scan`)
  NP_DEVICE_NAME  label shown in the dash (default: the name the device announces)
  NP_HOST         optional IP hint for a fast first connect (falls back to a multicast scan)
  NP_BIND, NP_PORT  listener (127.0.0.1:8102; 0.0.0.0 in Docker so the dash container can reach it)
"""
import asyncio
import hashlib
import json
import os
import re
import time
import sys
import urllib.request

import dashconfig  # loads the repo-root .env, stdlib only
import pyatv
from aiohttp import web
from pyatv.const import DeviceState, FeatureName, FeatureState, RepeatState, ShuffleState
from pyatv.interface import AudioListener, DeviceListener, PushListener

DEVICE_ID = os.environ.get('NP_DEVICE_ID', '').strip()
DEVICE_NAME = os.environ.get('NP_DEVICE_NAME', '').strip()
HINT_HOST = os.environ.get('NP_HOST', '').strip()
# Empty NP_BIND (as in .env.example) must not undo the image default: compose passes empty values through env_file.
BIND = os.environ.get('NP_BIND', '').strip() or ('0.0.0.0' if dashconfig.IN_DOCKER else '127.0.0.1')
PORT = int(os.environ.get('NP_PORT', '').strip() or '8102')
if not DEVICE_ID:
    sys.exit('nowplaying: NP_DEVICE_ID is not set (find it with `atvremote scan`); see docs/configuration.md')
ACTIONS = {
    'play_pause': (FeatureName.PlayPause, lambda a: a.remote_control.play_pause()),
    'next': (FeatureName.Next, lambda a: a.remote_control.next()),
    'previous': (FeatureName.Previous, lambda a: a.remote_control.previous()),
    'volume_up': (FeatureName.VolumeUp, lambda a: a.audio.volume_up()),
    'volume_down': (FeatureName.VolumeDown, lambda a: a.audio.volume_down()),
}


def log(*a):
    print(time.strftime('%H:%M:%S'), *a, flush=True)


def enum_name(v):
    return v.name.lower() if v is not None and hasattr(v, 'name') else None


class NowPlaying(PushListener, DeviceListener, AudioListener):
    def __init__(self):
        self.atv = None
        self.host = HINT_HOST
        self.state = {'available': False, 'device': DEVICE_NAME, 'device_state': 'idle', 'error': 'connecting'}
        self.art: tuple[bytes, str, str] | None = None  # (bytes, mimetype, hash)
        self.art_key = None   # track identity the artwork belongs to
        self.art_cache: dict = {}  # track key -> art tuple (bounded), so going back to a track doesn't refetch
        self.lost = asyncio.Event()
        self._art_task = None

    # ---------- pyatv listeners
    def playstatus_update(self, updater, playstatus):
        self._apply(playstatus)

    def playstatus_error(self, updater, exception):
        log('push error', exception)

    def connection_lost(self, exception):
        log('connection lost', exception)
        self.lost.set()

    def connection_closed(self):
        log('connection closed')
        self.lost.set()

    def volume_update(self, old_level, new_level):
        self.state['volume'] = round(new_level)

    def outputdevices_update(self, old_devices, new_devices):
        pass

    def volume_device_update(self, output_device, old_level, new_level):
        pass

    # ---------- state
    def _apply(self, p):
        ds = enum_name(p.device_state) or 'idle'
        playing = ds in ('playing', 'paused', 'loading', 'seeking')
        title = p.title if playing else None
        st = {
            'available': True, 'device': DEVICE_NAME, 'device_state': ds,
            'title': title, 'artist': p.artist if playing else None, 'album': p.album if playing else None,
            'genre': p.genre if playing else None,
            'position': p.position if playing else None, 'total_time': p.total_time if playing else None,
            'sampled_at': time.time(),
            'shuffle': enum_name(p.shuffle) if p.shuffle not in (None, ShuffleState.Off) else 'off',
            'repeat': enum_name(p.repeat) if p.repeat not in (None, RepeatState.Off) else 'off',
            'media_type': enum_name(p.media_type),
            'volume': self._volume(),
            'app': None, 'app_id': None,
            'can': self._can(),
        }
        try:
            app = self.atv.metadata.app
            if app:
                st['app'], st['app_id'] = app.name, app.identifier
        except Exception:  # noqa: BLE001 — not every protocol exposes it
            pass
        key = (st['title'], st['artist'], st['album']) if title else None
        prev = self.state
        if (ds == 'paused' and not p.position and key == self.art_key and prev.get('position')):
            # HomePod's pause update carries elapsed=0; keep where we were (extrapolated if it was playing).
            run = time.time() - prev['sampled_at'] if prev.get('device_state') == 'playing' else 0
            st['position'] = min(prev['position'] + run, st['total_time'] or 1e9)
        self.state = st
        if key != self.art_key:
            self.art_key = key
            self.art = None
            if self._art_task and not self._art_task.done():
                self._art_task.cancel()
            self._art_task = asyncio.get_running_loop().create_task(self._fetch_art(key)) if key else None

    def _volume(self):
        try:
            if self.atv.features.in_state(FeatureState.Available, FeatureName.Volume):
                return round(self.atv.audio.volume)
        except Exception:  # noqa: BLE001
            pass
        return None

    def _can(self):
        out = {}
        for k, (feat, _) in ACTIONS.items():
            try:
                out[k] = self.atv.features.in_state(FeatureState.Available, feat)
            except Exception:  # noqa: BLE001
                out[k] = False
        return out

    async def _fetch_art(self, key):
        cached = self.art_cache.get(key)
        if cached:
            self.art = cached
            return
        # HomePod (tvOS 27) answers MRP artwork requests with empty bytes for Apple Music, but it does give
        # the Apple Music CDN path in artwork_id ("Music116/v4/.../x.jpg"), so fetch that from mzstatic.
        # The push update often lands before either is ready; retry briefly.
        for delay in (0.3, 1.5, 4):
            await asyncio.sleep(delay)
            if key != self.art_key or not self.atv:
                return
            got = None
            try:
                a = await self.atv.metadata.artwork(width=1024, height=1024)
                if a and a.bytes:
                    got = (a.bytes, a.mimetype or 'image/jpeg')
            except Exception as e:  # noqa: BLE001
                log('artwork error', e)
            if not got:
                aid = getattr(self.atv.metadata, 'artwork_id', None) or ''
                if re.match(r'^[A-Za-z]+\d*/v\d/.+\.(jpg|jpeg|png)$', aid):
                    got = await asyncio.to_thread(self._mzstatic, aid)
            if got:
                if key == self.art_key:
                    self.art = (got[0], got[1], hashlib.sha1(got[0]).hexdigest()[:12])
                    self.art_cache[key] = self.art
                    while len(self.art_cache) > 30:
                        self.art_cache.pop(next(iter(self.art_cache)))
                    log(f'artwork {len(got[0])} B for {key[0]!r}')
                return
        log(f'no artwork for {key[0]!r}')

    @staticmethod
    def _mzstatic(aid):
        url = f'https://is1-ssl.mzstatic.com/image/thumb/{aid}/1000x1000bb.jpg'
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                return r.read(), r.headers.get('content-type', 'image/jpeg')
        except Exception as e:  # noqa: BLE001
            log('mzstatic error', e)
            return None

    def public(self):
        s = dict(self.state)
        s['artwork_hash'] = self.art[2] if self.art else None
        return s

    # ---------- connection loop
    async def _find(self, loop):
        # Fast path: the last known address. Fallback: full multicast scan by identifier (IP changed).
        for hosts in ([[self.host]] if self.host else []) + [None]:
            kw = {'hosts': hosts} if hosts else {}
            confs = await pyatv.scan(loop, identifier=DEVICE_ID, timeout=5, **kw)
            if confs:
                global DEVICE_NAME
                self.host = str(confs[0].address)
                DEVICE_NAME = DEVICE_NAME or confs[0].name
                return confs[0]
        return None

    async def run(self):
        loop = asyncio.get_running_loop()
        backoff = 2
        while True:
            try:
                conf = await self._find(loop)
                if not conf:
                    raise ConnectionError('HomePod not found on the network')
                self.atv = await pyatv.connect(conf, loop)
                self.lost.clear()
                self.atv.listener = self
                self.atv.audio.listener = self
                self.atv.push_updater.listener = self
                self.atv.push_updater.start()
                log('connected', self.host)
                backoff = 2
                self._apply(await self.atv.metadata.playing())
                while not self.lost.is_set():
                    try:
                        await asyncio.wait_for(self.lost.wait(), 60)
                    except asyncio.TimeoutError:
                        # Keep-alive + refresh position/volume (push only fires on changes).
                        self._apply(await asyncio.wait_for(self.atv.metadata.playing(), 15))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log('error', type(e).__name__, e)
                self.state = {'available': False, 'device': DEVICE_NAME, 'device_state': 'idle', 'error': str(e) or type(e).__name__}
            if self.atv:
                try:
                    self.atv.close()
                except Exception:  # noqa: BLE001
                    pass
                self.atv = None
            self.state = {**self.state, 'available': False}
            self.art_key = None
            log(f'reconnect in {backoff}s')
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    async def command(self, action):
        if action not in ACTIONS:
            return 400, {'error': 'unknown action'}
        if not self.atv:
            return 503, {'error': 'HomePod not connected'}
        try:
            await asyncio.wait_for(ACTIONS[action][1](self.atv), 8)
        except Exception as e:  # noqa: BLE001
            return 502, {'error': str(e) or type(e).__name__}
        # Push update follows; refresh volume eagerly so the UI reflects it on the next poll.
        if action.startswith('volume'):
            self.state['volume'] = self._volume()
        return 200, {'ok': True}


NP = NowPlaying()


async def h_state(_req):
    return web.json_response(NP.public(), headers={'Cache-Control': 'no-store'})


async def h_art(_req):
    if not NP.art:
        return web.Response(status=404, text='no artwork')
    return web.Response(body=NP.art[0], content_type=NP.art[1], headers={'X-Art-Hash': NP.art[2]})


async def h_cmd(req):
    try:
        action = (await req.json()).get('action')
    except Exception:  # noqa: BLE001
        return web.json_response({'error': 'bad json'}, status=400)
    code, body = await NP.command(action)
    return web.json_response(body, status=code)


async def main():
    app = web.Application()
    app.add_routes([web.get('/state', h_state), web.get('/artwork', h_art), web.post('/cmd', h_cmd)])
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, BIND, PORT).start()
    log(f'nowplaying sidecar on {BIND}:{PORT}, device {DEVICE_ID}')
    await NP.run()


if __name__ == '__main__':
    asyncio.run(main())
