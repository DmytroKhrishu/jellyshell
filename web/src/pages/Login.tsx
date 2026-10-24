import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, IconName } from '../components/icons';
import {
  ApiError, DEFAULT_SERVER, lastServer, passwordAuth, quickConnectAuth, quickConnectEnabled, quickConnectInitiate,
  quickConnectState, serverInfo, setAuth,
} from '../lib/jellyfin';
import { focusEl, focusFirst } from '../lib/focus';
import { log } from '../lib/log';
import { uiMode } from '../lib/mode';

type Mode = 'qc' | 'password';
const SERVER_KEY = 'jellyshell.server';
const USER_KEY = 'jellyshell.lastUser';

/** Human error text for a failed sign-in / probe. Never includes the password. */
function signInError(e: any, server: string) {
  if (e instanceof ApiError) {
    if (e.status === 401) return 'Wrong username or password.';
    if (e.status === 403) return 'This account is disabled or not allowed to sign in from here.';
    if (e.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (e.status >= 500) return `The server had a problem (${e.status}). Try again in a moment.`;
    return `Sign-in failed (${e.status}).`;
  }
  // fetch() rejects with a TypeError when the host is down / unreachable / blocked (CORS, mixed content).
  return `Can't reach the server at ${server.replace(/^https?:\/\//, '')}. Check the address and that you're on the same network (or Tailscale).`;
}

export function Login() {
  const [server, setServer] = useState(lastServer());
  const [serverName, setServerName] = useState<string>('');
  const [reach, setReach] = useState<'checking' | 'ok' | 'down'>('checking');
  const [mode, setMode] = useState<Mode>(uiMode.value === 'tv' ? 'qc' : 'password');
  const [editServer, setEditServer] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // Probe the server whenever its URL changes; remember it once it answers.
  useEffect(() => {
    let stop = false;
    setReach('checking');
    serverInfo(server)
      .then((info) => {
        if (stop) return;
        setServerName(info.ServerName);
        setReach('ok');
        localStorage.setItem(SERVER_KEY, server);
      })
      .catch(() => {
        if (stop) return;
        setServerName('');
        setReach('down');
      });
    return () => {
      stop = true;
    };
  }, [server]);

  // TV: focus the active segment so D-pad left/right flips between methods; mobile/desktop: the form handles itself.
  useEffect(() => {
    if (uiMode.value !== 'tv') return;
    requestAnimationFrame(() => focusEl(panel.current?.querySelector<HTMLElement>('.seg.on')) || focusFirst(panel.current));
  }, []);

  const done = (r: { AccessToken: string; User: { Id: string; Name: string } }) =>
    setAuth({ server, token: r.AccessToken, userId: r.User.Id, userName: r.User.Name, serverName });

  return (
    <div class="login">
      <div class="login-brand">
        <h1>
          Jelly<span>Shell</span>
        </h1>
        <p class="login-tag">Your Jellyfin library, made for the couch.</p>
      </div>
      <div class="login-panel" ref={panel} data-scope>
        <div class="seg-ctl" role="tablist" data-group="login-seg">
          <div
            class={'seg focusable' + (mode === 'qc' ? ' on' : '')}
            role="tab"
            aria-selected={mode === 'qc'}
            tabIndex={-1}
            data-fkey="seg-qc"
            onClick={() => setMode('qc')}
            onFocus={() => uiMode.value === 'tv' && setMode('qc')}
          >
            Quick Connect
          </div>
          <div
            class={'seg focusable' + (mode === 'password' ? ' on' : '')}
            role="tab"
            aria-selected={mode === 'password'}
            tabIndex={-1}
            data-fkey="seg-pw"
            onClick={() => setMode('password')}
            onFocus={() => uiMode.value === 'tv' && setMode('password')}
          >
            {uiMode.value === 'mobile' ? 'Password' : 'Username & Password'}
          </div>
        </div>

        {mode === 'qc' ? <QuickConnect server={server} reach={reach} onDone={done} /> : <PasswordForm server={server} reach={reach} onDone={done} />}

        <div class="login-server">
          {editServer ? (
            <ServerForm
              initial={server}
              onDone={(s) => {
                const v = normalizeServer(s);
                setServer(v);
                setEditServer(false);
              }}
              onCancel={() => setEditServer(false)}
            />
          ) : (
            <>
              <span class={'srv-dot ' + reach} aria-hidden="true" />
              <span class="srv-name">
                {serverName || (reach === 'checking' ? 'Connecting…' : reach === 'down' ? 'Server unreachable' : 'Jellyfin')}
                <small>{server.replace(/^https?:\/\//, '')}</small>
              </span>
              <div class="pill focusable srv-change" tabIndex={-1} data-fkey="srv-change" onClick={() => setEditServer(true)}>
                Change
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function normalizeServer(s: string) {
  let v = s.trim().replace(/\/+$/, '');
  if (!v) return DEFAULT_SERVER;
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  if (!/:\d+$/.test(v.replace(/^https?:\/\//, '')) && /^http:/.test(v)) v += ':8096';
  return v;
}

function QuickConnect({ server, reach, onDone }: { server: string; reach: string; onDone: (r: any) => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (reach !== 'ok') return;
    let stop = false;
    let poll: number | undefined;
    (async () => {
      setErr('');
      setCode('');
      try {
        if (!(await quickConnectEnabled(server))) {
          setErr('Quick Connect is turned off on this server. Use username & password.');
          return;
        }
        const qc = await quickConnectInitiate(server);
        if (stop) return;
        setCode(qc.Code);
        log('quickconnect code issued');
        const tick = async () => {
          if (stop) return;
          try {
            const st = await quickConnectState(server, qc.Secret);
            if (st.Authenticated) {
              const r = await quickConnectAuth(server, qc.Secret);
              log('quickconnect ok', r.User.Name);
              onDone(r);
              return;
            }
          } catch (e) {
            log('qc poll error', String(e));
          }
          poll = window.setTimeout(tick, 2500);
        };
        tick();
      } catch (e) {
        setErr(signInError(e, server));
      }
    })();
    return () => {
      stop = true;
      window.clearTimeout(poll);
    };
  }, [server, reach]);

  return (
    <div class="login-body qc">
      <div class="qc-steps">
        In another signed-in Jellyfin app open <b>Settings → Quick Connect</b> and enter this code:
      </div>
      <div class="qc-code">{reach === 'down' ? '——' : code || '······'}</div>
      <div class="qc-wait">
        {code && !err && (
          <>
            <div class="spinner" /> Waiting for approval…
          </>
        )}
      </div>
      {reach === 'down' && <div class="err">{signInError(new TypeError(), server)}</div>}
      {err && <div class="err">{err}</div>}
    </div>
  );
}

function PasswordForm({ server, reach, onDone }: { server: string; reach: string; onDone: (r: any) => void }) {
  const [user, setUser] = useState(() => localStorage.getItem(USER_KEY) ?? '');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pwRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);

  // Desktop: put the caret straight into the first empty field (mobile waits for a tap so the keyboard doesn't jump up).
  useEffect(() => {
    if (uiMode.value !== 'desktop') return;
    (user ? pwRef : userRef).current?.focus();
  }, []);

  async function submit(e?: Event) {
    e?.preventDefault();
    if (busy) return;
    const u = user.trim();
    if (!u) {
      setErr('Enter your username.');
      userRef.current?.focus();
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await passwordAuth(server, u, pw);
      localStorage.setItem(USER_KEY, u);
      localStorage.setItem(SERVER_KEY, server);
      log('password sign-in ok', r.User.Name); // never the password
      setPw('');
      onDone(r);
    } catch (ex: any) {
      log('password sign-in failed', ex instanceof ApiError ? ex.status : 'network');
      setErr(signInError(ex, server));
      setBusy(false);
      pwRef.current?.select?.();
    }
  }

  return (
    <form class="login-body pw" onSubmit={submit} autocomplete="on" action="#" method="post">
      <Field
        label="Username"
        name="username"
        inputRef={userRef}
        value={user}
        onInput={setUser}
        autocomplete="username"
        enterKeyHint="next"
        autocapitalize="none"
        onEnter={() => pwRef.current?.focus()}
        data-autofocus
      />
      <Field
        label="Password"
        name="password"
        inputRef={pwRef}
        value={pw}
        onInput={setPw}
        type={show ? 'text' : 'password'}
        autocomplete="current-password"
        enterKeyHint="go"
        onEnter={() => submit()}
        after={
          <span
            class="pw-toggle focusable"
            role="button"
            tabIndex={-1}
            aria-label={show ? 'Hide password' : 'Show password'}
            onMouseDown={(e) => e.preventDefault() /* keep the caret in the field */}
            onClick={(e) => {
              e.stopPropagation();
              setShow((v) => !v);
            }}
          >
            {show ? 'Hide' : 'Show'}
          </span>
        }
      />
      {err && (
        <div class="err" role="alert">
          {err}
        </div>
      )}
      <button type="submit" class={'btn focusable btn-primary' + (busy || reach === 'down' ? ' busy' : '')} tabIndex={-1} disabled={busy}>
        {busy ? (
          <>
            <span class="spinner" /> Signing in…
          </>
        ) : (
          'Sign In'
        )}
      </button>
    </form>
  );
}

/** Real form input wrapped as a focusable field (A on the wrapper opens the Xbox keyboard; a tap goes straight to the input). */
function Field(p: {
  label: string;
  name: string;
  value: string;
  onInput: (v: string) => void;
  inputRef: { current: HTMLInputElement | null };
  type?: string;
  autocomplete: string;
  enterKeyHint: string;
  autocapitalize?: string;
  onEnter?: () => void;
  after?: preact.ComponentChildren;
  'data-autofocus'?: boolean;
}) {
  const id = 'f-' + p.name;
  return (
    <div class="field login-field focusable" tabIndex={-1} data-autofocus={p['data-autofocus'] || undefined} onClick={() => p.inputRef.current?.focus()}>
      <label for={id}>{p.label}</label>
      <input
        id={id}
        ref={p.inputRef}
        name={p.name}
        type={p.type ?? 'text'}
        value={p.value}
        autocomplete={p.autocomplete}
        autocapitalize={(p.autocapitalize ?? "none") as any}
        autocorrect="off"
        spellcheck={false}
        enterkeyhint={p.enterKeyHint as any}
        onInput={(e) => p.onInput((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && p.onEnter) {
            e.preventDefault();
            p.onEnter();
          }
        }}
      />
      {p.after}
    </div>
  );
}

function ServerForm({ initial, onDone, onCancel }: { initial: string; onDone: (s: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (uiMode.value !== 'tv') ref.current?.focus();
    else requestAnimationFrame(() => focusEl(ref.current?.closest<HTMLElement>('.focusable')));
  }, []);
  return (
    <form
      class="srv-form"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(v);
      }}
    >
      <Field label="Server" name="server" inputRef={ref} value={v} onInput={setV} type="url" autocomplete="url" enterKeyHint="done" onEnter={() => onDone(v)} />
      <div class="btn-row">
        <button type="submit" class="btn focusable" tabIndex={-1}>
          Connect
        </button>
        <div class="btn focusable" tabIndex={-1} onClick={() => onDone(DEFAULT_SERVER)}>
          Default ({DEFAULT_SERVER.replace(/^https?:\/\//, '')})
        </div>
        <div class="btn focusable" tabIndex={-1} onClick={onCancel}>
          Cancel
        </div>
      </div>
    </form>
  );
}

/** Text input wrapped as a focusable field: A/Enter on the wrapper focuses the real input (system keyboard on Xbox). */
export function TextField(p: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  type?: string;
  autofocus?: boolean;
  onEnter?: () => void;
  placeholder?: string;
  enterKeyHint?: string;
  inputMode?: string;
  icon?: IconName;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div class="field focusable" tabIndex={-1} data-autofocus={p.autofocus || undefined} onClick={() => input.current?.focus()}>
      {p.icon ? <Icon name={p.icon} class="field-ico" /> : <label>{p.label}</label>}
      <input
        ref={input}
        type={p.type ?? 'text'}
        value={p.value}
        placeholder={p.placeholder}
        aria-label={p.label}
        autocomplete="off"
        autocapitalize="none"
        autocorrect="off"
        spellcheck={false}
        enterkeyhint={(p.enterKeyHint ?? (p.type === 'search' ? 'search' : 'done')) as any}
        inputMode={p.inputMode as any}
        onInput={(e) => p.onInput((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur(); // closes the phone keyboard
            (e.currentTarget.parentElement as HTMLElement).focus({ preventScroll: true });
            p.onEnter?.();
          }
        }}
      />
    </div>
  );
}
