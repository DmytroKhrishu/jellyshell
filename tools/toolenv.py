"""Shared settings for the dev tools in tools/: environment variables, optionally seeded from the repo-root `.env`.

  XBOX_HOST            Xbox Dev Mode IP/hostname (Device Portal at https://XBOX_HOST:11443), e.g. <xbox-lan-ip>
  XBOX_PORTAL_URL      full Device Portal URL instead of XBOX_HOST (default https://$XBOX_HOST:11443)
  XBOX_PORTAL_CRED_FILE  file holding "user:pass" for the Device Portal (default ~/.config/xbox-devportal.cred)
  JELLYSHELL_URL       the page server the console/browser loads (default http://127.0.0.1:8097)
  JELLYFIN_URL         Jellyfin as this machine reaches it (default http://127.0.0.1:8096)
  JELLYFIN_CLIENT_URL  Jellyfin as the console reaches it, for stream URLs (default: JELLYFIN_URL)
  JELLYFIN_API_KEY / JELLYFIN_API_KEY_FILE, JELLYFIN_USER_ID   testing-only sign-in (`ui.py auth`, `drive.py jf`)
  GITHUB_REPOSITORY    owner/repo for CI artifacts (default: `gh repo view` of this checkout)
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_env(path):
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('export '):
            line = line[7:].lstrip()
        k, sep, v = line.partition('=')
        k, v = k.strip(), v.strip()
        if not sep or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', k):
            continue
        if v[:1] in ('"', "'") and v[0] in v[1:]:  # quoted value, then an optional ' # comment'
            v = v[1:v.index(v[0], 1)]
        elif ' #' in v:
            v = v.split(' #', 1)[0].rstrip()
        os.environ.setdefault(k, v)


_load_env(os.environ.get('JELLYSHELL_ENV_FILE') or REPO_ROOT / '.env')


def env(name, default=''):
    v = os.environ.get(name)
    return default if v is None or v.strip() == '' else v.strip()


def need(name, hint=''):
    v = env(name)
    if not v:
        sys.exit(f'{name} is not set{": " + hint if hint else ""} (env var or repo-root .env; see docs/configuration.md)')
    return v


def portal_url():
    if env('XBOX_PORTAL_URL'):
        return env('XBOX_PORTAL_URL').rstrip('/')
    return f"https://{need('XBOX_HOST', 'the Xbox Dev Mode IP, e.g. <xbox-lan-ip>')}:11443"


def portal_cred():
    p = Path(env('XBOX_PORTAL_CRED_FILE', '~/.config/xbox-devportal.cred')).expanduser()
    try:
        return p.read_text().strip()
    except OSError:
        sys.exit(f'Device Portal credentials not found: put "user:pass" in {p} or set XBOX_PORTAL_CRED_FILE')


def page_url():
    return env('JELLYSHELL_URL', 'http://127.0.0.1:8097').rstrip('/')


def jellyfin_url():
    u = env('JELLYFIN_URL', 'http://127.0.0.1:8096').rstrip('/')
    # The shared .env often holds the Docker view (host.docker.internal); these tools run on the host itself.
    if '//host.docker.internal' in u and os.environ.get('JELLYSHELL_DOCKER') != '1':
        u = u.replace('//host.docker.internal', '//127.0.0.1')
    return u


def jellyfin_client_url():
    return env('JELLYFIN_CLIENT_URL', jellyfin_url()).rstrip('/')


def jellyfin_key():
    """(api key, user id) for testing-only tools. JELLYFIN_API_KEY_FILE may hold the raw key or JSON {key, userId}."""
    key, uid = env('JELLYFIN_API_KEY'), env('JELLYFIN_USER_ID')
    f = env('JELLYFIN_API_KEY_FILE')
    if f and (not key or not uid):
        txt = Path(f).expanduser().read_text().strip()
        if txt.startswith('{'):
            j = json.loads(txt)
            key, uid = key or j.get('key', ''), uid or j.get('userId', '')
        else:
            key = key or txt
    if not key or not uid:
        sys.exit('set JELLYFIN_API_KEY (or JELLYFIN_API_KEY_FILE) and JELLYFIN_USER_ID for this test command')
    return key, uid


def github_repo():
    if env('GITHUB_REPOSITORY'):
        return env('GITHUB_REPOSITORY')
    try:
        out = subprocess.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd=REPO_ROOT,
                             capture_output=True, text=True, check=True, timeout=30)
        if out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    sys.exit('GITHUB_REPOSITORY is not set and `gh repo view` failed (set it to owner/repo)')
