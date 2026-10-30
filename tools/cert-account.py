#!/usr/bin/env python3
"""Microsoft Store certification tester account for JellyShell (Jellyfin user on this host).

  tools/cert-account.py status [--name N]   show whether the account exists and its policy
  tools/cert-account.py create [--name N]   create it (or reset its password + policy if it exists)
  tools/cert-account.py delete [--name N]   delete it and its credential file

The account is non-admin, hidden from the login screen, remote access allowed (the tester comes in over your
public Jellyfin URL: reverse proxy / Tailscale Funnel / Cloudflare Tunnel), no deleting/downloading/conversion, no Live TV, no sharing or remote control, and sees
only the Movies + Shows libraries. A strong random password is written to ~/.config/jellyshell-cert-<name>.json
(mode 600) and printed once, for the Partner Center "Notes for certification" separate note.

Config (env or the repo-root .env, see tools/toolenv.py):
  JELLYFIN_URL (default http://127.0.0.1:8096), JELLYFIN_API_KEY or JELLYFIN_API_KEY_FILE (admin key, sent in the Authorization header),
  JELLYFIN_PUBLIC_URL (the server URL written into the credential file for the tester), CERT_ACCOUNT_NAME (default cert-tester).
"""
import argparse
import json
import os
import secrets
import string
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import toolenv  # noqa: E402

JF = toolenv.jellyfin_url()
DEFAULT_NAME = toolenv.env('CERT_ACCOUNT_NAME', 'cert-tester')


def _admin_key():
    key = toolenv.env('JELLYFIN_API_KEY')
    if not key and toolenv.env('JELLYFIN_API_KEY_FILE'):
        txt = Path(toolenv.env('JELLYFIN_API_KEY_FILE')).expanduser().read_text().strip()
        key = json.loads(txt).get('key', '') if txt.startswith('{') else txt
    if not key:
        sys.exit('set JELLYFIN_API_KEY (or JELLYFIN_API_KEY_FILE) to a Jellyfin admin API key')
    return key


KEY = _admin_key()
LIBRARY_TYPES = ('movies', 'tvshows')


def api(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(JF + path, data=data, method=method,
                                 headers={'Authorization': f'MediaBrowser Token="{KEY}"', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {path} -> HTTP {e.code}: {e.read()[:300].decode(errors="replace")}')
    return json.loads(raw) if raw else None


def cred_file(name):
    return Path(f'~/.config/jellyshell-cert-{name}.json').expanduser()


def find_user(name):
    return next((u for u in api('GET', '/Users') if u['Name'].lower() == name.lower()), None)


def libraries():
    libs = [f for f in api('GET', '/Library/VirtualFolders') if f.get('CollectionType') in LIBRARY_TYPES]
    if not libs:
        sys.exit('no Movies/Shows libraries found')
    return libs


def strong_password():
    alphabet = string.ascii_letters + string.digits + '-_.~!@#%^*'
    while True:
        pw = ''.join(secrets.choice(alphabet) for _ in range(28))
        if (any(c.islower() for c in pw) and any(c.isupper() for c in pw) and any(c.isdigit() for c in pw)
                and any(not c.isalnum() for c in pw)):
            return pw


def apply_policy(user, libs):
    p = api('GET', f'/Users/{user["Id"]}')['Policy']  # keeps the auth/reset provider ids Jellyfin requires
    p.update({
        'IsAdministrator': False, 'IsHidden': True, 'IsDisabled': False,
        'EnableRemoteAccess': True,               # tester signs in over the public Funnel URL
        'EnableContentDeletion': False, 'EnableContentDeletionFromFolders': [],
        'EnableContentDownloading': False, 'EnableMediaConversion': False,
        'EnableLiveTvAccess': False, 'EnableLiveTvManagement': False,
        'EnableCollectionManagement': False, 'EnableSubtitleManagement': False, 'EnableLyricManagement': False,
        'EnablePublicSharing': False, 'EnableRemoteControlOfOtherUsers': False, 'EnableSharedDeviceControl': False,
        'EnableAllChannels': False, 'EnabledChannels': [],
        'EnableAllFolders': False, 'EnabledFolders': [f['ItemId'] for f in libs],
        'EnableAllDevices': True,
        'EnableMediaPlayback': True, 'EnableAudioPlaybackTranscoding': True,
        'EnableVideoPlaybackTranscoding': True, 'EnablePlaybackRemuxing': True,
        'ForceRemoteSourceTranscoding': False,
        'MaxActiveSessions': 2, 'LoginAttemptsBeforeLockout': 10,
        'SyncPlayAccess': 'None',
    })
    api('POST', f'/Users/{user["Id"]}/Policy', p)


def show(user, libs_by_id):
    p = api('GET', f'/Users/{user["Id"]}')['Policy']
    folders = [libs_by_id.get(i, i) for i in p.get('EnabledFolders', [])]
    print(json.dumps({
        'name': user['Name'], 'id': user['Id'], 'hasPassword': user.get('HasPassword'),
        'admin': p['IsAdministrator'], 'hidden': p['IsHidden'], 'disabled': p['IsDisabled'],
        'remoteAccess': p['EnableRemoteAccess'], 'contentDeletion': p['EnableContentDeletion'],
        'downloads': p['EnableContentDownloading'], 'liveTv': p['EnableLiveTvAccess'],
        'allFolders': p['EnableAllFolders'], 'folders': folders,
        'lastLogin': user.get('LastLoginDate'),
    }, indent=2))


def cmd_status(name):
    libs_by_id = {f['ItemId']: f['Name'] for f in api('GET', '/Library/VirtualFolders')}
    user = find_user(name)
    f = cred_file(name)
    if not user:
        print(f'{name}: not present' + (f' (stale credential file {f})' if f.exists() else ''))
        return 1
    show(user, libs_by_id)
    print(f'credential file: {f} ' + (oct(f.stat().st_mode & 0o777) if f.exists() else 'MISSING'))
    return 0


def cmd_create(name):
    libs = libraries()
    user = find_user(name)
    if user and user['Policy']['IsAdministrator']:
        sys.exit(f'refusing: {name} is an administrator')
    pw = strong_password()
    if user:
        print(f'{name} exists, resetting password and policy')
        api('POST', f'/Users/{user["Id"]}/Password', {'ResetPassword': True})
        api('POST', f'/Users/{user["Id"]}/Password', {'CurrentPw': '', 'NewPw': pw})
    else:
        user = api('POST', '/Users/New', {'Name': name, 'Password': pw})
    apply_policy(user, libs)
    f = cred_file(name)
    f.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        json.dump({'server': toolenv.env('JELLYFIN_PUBLIC_URL', JF), 'username': name, 'password': pw,
                   'userId': user['Id']}, fh, indent=2)
    os.chmod(f, 0o600)
    # prove the credentials work
    auth = urllib.request.Request(JF + '/Users/AuthenticateByName', method='POST',
                                  data=json.dumps({'Username': name, 'Pw': pw}).encode(),
                                  headers={'Content-Type': 'application/json', 'Authorization':
                                           'MediaBrowser Client="cert-account", Device="cert-account", DeviceId="cert-account", Version="1"'})
    with urllib.request.urlopen(auth, timeout=15) as r:
        tok = json.load(r)['AccessToken']
    urllib.request.urlopen(urllib.request.Request(JF + '/Sessions/Logout', method='POST', data=b'',
                                                  headers={'Authorization': f'MediaBrowser Token="{tok}"'}), timeout=15)
    print(f'created {name} ({user["Id"]}); login verified; credentials in {f} (600)')
    print(f'password (for the separate certification note): {pw}')
    return cmd_status(name)


def cmd_delete(name):
    user = find_user(name)
    f = cred_file(name)
    if user:
        if user['Policy']['IsAdministrator']:
            sys.exit(f'refusing: {name} is an administrator')
        api('DELETE', f'/Users/{user["Id"]}')
        print(f'deleted {name} ({user["Id"]})')
    else:
        print(f'{name}: not present')
    if f.exists():
        f.unlink()
        print(f'removed {f}')
    if find_user(name):
        sys.exit(f'{name} still listed in /Users')
    print(f'/Users: {name} gone')
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', choices=('create', 'delete', 'status'))
    ap.add_argument('--name', default=DEFAULT_NAME, help=f'account name (default {DEFAULT_NAME})')
    a = ap.parse_args()
    return {'create': cmd_create, 'delete': cmd_delete, 'status': cmd_status}[a.command](a.name)


if __name__ == '__main__':
    sys.exit(main())
