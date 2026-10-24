"""Drive the JellyShell web UI remotely through the page server's /api/cmd queue.

  python3 tools/ui.py auth                  -> sign the page in with JELLYFIN_API_KEY + JELLYFIN_USER_ID (testing only; never printed)
  python3 tools/ui.py keys 204 204 195      -> press Xbox keyCodes (203-206 dpad U/D/L/R, 195 A, 196 B, 199 RB, 200 LB, 201 LT, 202 RT, 197 X, 198 Y, 207 Menu)
  python3 tools/ui.py cmd '{"tab":"movies"}'-> any raw command ({"open":id} {"playId":id} {"stop":true} {"back":true} {"state":true} {"reload":true})
  python3 tools/ui.py shot NAME             -> Xbox Device Portal screenshot -> web-poc/snaps/portal-NAME.png
Needs the page server started with JELLYSHELL_DEBUG=1; JELLYSHELL_URL points at it (default http://127.0.0.1:8097).
"""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import toolenv  # noqa: E402

PAGE = toolenv.page_url()
TARGET = 'xbox'


def post(obj):
    req = urllib.request.Request(f'{PAGE}/api/cmd?c={TARGET}', json.dumps(obj).encode(), method='POST')
    urllib.request.urlopen(req, timeout=5).read()


def main():
    global TARGET
    a = sys.argv[1:]
    if a and a[0] in ('--browser', '-b'):
        TARGET, a = 'browser', a[1:]
    elif a and a[0].startswith('--target='):  # page opened with ?remote=NAME
        TARGET, a = a[0].split('=', 1)[1], a[1:]
    if a[0] == 'auth':
        key, uid = toolenv.jellyfin_key()
        post({'auth': {'token': key, 'userId': uid, 'userName': 'api key (test)', 'serverName': 'Jellyfin'}})
        print('auth queued')
    elif a[0] == 'keys':
        post({'keys': [int(k) for k in a[1:]], 'gap': 300})
        print('keys queued', a[1:])
    elif a[0] == 'cmd':
        post(json.loads(a[1]))
        print('cmd queued')
    elif a[0] == 'shot':
        sys.path.insert(0, str(Path(__file__).parent))
        import drive
        drive.shot(a[1])


if __name__ == '__main__':
    main()
