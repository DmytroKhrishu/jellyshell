import { useEffect, useRef } from 'preact/hooks';
import { openPicker } from '../components/Dialog';
import { setBackdrop } from '../components/Backdrop';
import { auth, logout, VERSION, DEVICE_ID } from '../lib/jellyfin';
import { settings, updateSettings, LANGS, langName } from '../lib/settings';
import { useInitialFocus } from '../lib/useInitialFocus';
import { capabilities, capsSource, isNative } from '../lib/bridge';
import { audioBoost, BOOST_STEPS, boostAvailable, boostLabel, setBoost } from '../lib/audioboost';
import { picture, loadPicture, brightnessLabel, contrastLabel } from '../lib/picture';
import { openPictureDialog } from '../components/PictureDialog';
import { TIME_ZONES, activeTz, clientTz, serverTz, tzLabel, fmtTimeIn } from '../lib/clock';
import { sideInfo, setStartSide } from '../lib/sides';
import { NEXT_AUTOPLAY } from '../components/NextCountdown';
import { uiServers } from '../lib/uiservers';
import { openUiServerDialog, uiServerLabel, UiServerDialog } from '../components/UiServerDialog';
import { openRemoteDialog, RemoteDialog } from '../components/RemoteDialog';
import { remotes } from '../lib/remote';
import { noPageServer } from '../lib/uisource';

const STILL_WATCHING: [number, string][] = [[0, 'Off'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], [180, '3 hours']];
const SKIP_INTROS: ['ask' | 'seen' | 'always', string, string][] = [
  ['ask', 'Ask', 'Show a Skip button only'],
  ['seen', 'After first viewing', "Watch a show's intro once, skip it after that"],
  ['always', 'Always', 'Skip every intro and recap, films too'],
];

function SetRow({ label, value, hint, onClick, fkey }: { label: string; value: string; hint?: string; onClick: () => void; fkey?: string }) {
  return (
    <div class="set-row focusable" tabIndex={-1} onClick={onClick} data-fkey={fkey}>
      <span>
        {label}
        {hint && <span class="hint">{hint}</span>}
      </span>
      <span class="val">{value}</span>
    </div>
  );
}

export function Settings({ active }: { active: boolean }) {
  const s = settings.value;
  const a = auth.value;
  const ref = useRef<HTMLDivElement>(null);
  const pic = picture.value;
  useEffect(() => {
    if (active) loadPicture();
  }, [active]);
  useInitialFocus(ref, active, true);
  useEffect(() => {
    if (active) setBackdrop(null, 0.6, 0);
  }, [active]);

  const langPicker = (title: string, cur: string, extra: [string, string][], set: (v: string) => void) =>
    openPicker([{ title, options: [...extra, ...LANGS].map(([v, l]) => ({ label: l, value: v, selected: v === cur })), onPick: set }]);

  return (
    <div class="vscroll" ref={ref} data-vscroll data-margintop="10rem" data-marginbottom="5rem" data-group="settings">
      <div class="vtrack page-pad">
        <div class="settings">
          <h1 data-scrolltop>Settings</h1>
          <div class="set-group">
            <h3>Playback</h3>
            <SetRow
              label="HDR"
              hint="Off keeps the TV in SDR: the server converts HDR films to SDR (adjust below). Auto switches the TV to HDR for HDR content."
              value={s.hdr === 'off' ? 'Off' : 'Auto'}
              onClick={() => updateSettings({ hdr: s.hdr === 'off' ? 'auto' : 'off' })}
            />
            {s.hdr === 'off' && pic?.canEdit && (
              <SetRow
                label="HDR picture"
                hint="How bright HDR films look after conversion. Server-wide; applies from the next play (also in the player's Picture menu)."
                value={brightnessLabel(pic.brightness) + (contrastLabel(pic.contrast) !== 'Standard' ? ' · ' + contrastLabel(pic.contrast) : '')}
                fkey="set-pic-b"
                onClick={() => openPictureDialog()}
              />
            )}
            <SetRow
              label="Match frame rate"
              hint="Switch the TV to the video's frame rate (24p for films)."
              value={s.matchFrameRate ? 'On' : 'Off'}
              onClick={() => updateSettings({ matchFrameRate: !s.matchFrameRate })}
            />
            <SetRow
              label="Default audio language"
              value={s.audioLang ? langName(s.audioLang) : 'File default'}
              onClick={() => langPicker('Audio language', s.audioLang, [['', 'File default']], (v) => updateSettings({ audioLang: v }))}
            />
            <SetRow
              label="Subtitles"
              value={s.subLang === 'off' ? 'Off (forced only)' : s.subLang ? langName(s.subLang) : 'File default'}
              onClick={() =>
                langPicker('Subtitle language', s.subLang, [['off', 'Off (forced only)'], ['', 'File default']], (v) => updateSettings({ subLang: v }))
              }
            />
            {boostAvailable() ? (
              <SetRow
                label="Audio boost"
                hint="Louder quiet mixes (+dB with a limiter); Night mode evens out loud effects vs. dialogue. Also in the player's Audio & Subtitles."
                value={boostLabel(audioBoost.value.db) + (audioBoost.value.night ? ' · Night' : '')}
                onClick={() =>
                  openPicker(
                    [
                      { title: 'Audio boost', icon: 'boost', options: BOOST_STEPS.map((d) => ({ label: boostLabel(d), value: String(d), selected: d === audioBoost.value.db })), onPick: (v) => setBoost({ db: +v }) },
                      { title: 'Night mode', icon: 'night', options: [{ label: 'Off', value: '0', selected: !audioBoost.value.night }, { label: 'On', value: '1', selected: audioBoost.value.night }], onPick: (v) => setBoost({ night: v === '1' }) },
                    ],
                    false,
                  )
                }
              />
            ) : null}
            <SetRow
              label="Skip intros"
              hint="A show's intro plays once, then it's skipped (with a few seconds to go back). Recaps skip when bingeing."
              value={SKIP_INTROS.find(([v]) => v === s.skipIntros)?.[1] ?? 'After first viewing'}
              fkey="set-skipintros"
              onClick={() =>
                openPicker([{ title: 'Skip intros', options: SKIP_INTROS.map(([v, l, sub]) => ({ label: l, value: v, sub, selected: v === s.skipIntros })), onPick: (v) => updateSettings({ skipIntros: v as any }) }])
              }
            />
            <SetRow
              label="Next episode autoplay"
              hint="Countdown to the next episode once the credits start. Waits for the end if a scene follows the credits."
              value={NEXT_AUTOPLAY.find(([v]) => v === s.nextAutoplay)?.[1] ?? `${s.nextAutoplay} s`}
              fkey="set-nextautoplay"
              onClick={() =>
                openPicker([{ title: 'Next episode autoplay', options: NEXT_AUTOPLAY.map(([v, l]) => ({ label: l, value: String(v), sub: v === 0 ? 'Never start the next episode by itself' : v === -1 ? 'Start it when the file ends' : undefined, selected: v === s.nextAutoplay })), onPick: (v) => updateSettings({ nextAutoplay: +v }) }])
              }
            />
            <SetRow
              label="More Like This at credits"
              hint="Movies: when the end credits start, a row of related titles slides up. Down to browse, B to hide."
              value={s.creditsShelf ? 'On' : 'Off'}
              fkey="set-creditsshelf"
              onClick={() => updateSettings({ creditsShelf: !s.creditsShelf })}
            />
            <SetRow
              label="Still watching check"
              hint="Episodes only: after this long with no button presses, playback stops and asks if you're still there."
              value={STILL_WATCHING.find(([m]) => m === s.stillWatchingMin)?.[1] ?? `${s.stillWatchingMin} min`}
              fkey="set-stillwatching"
              onClick={() => openPicker([{ title: 'Still watching check', options: STILL_WATCHING.map(([m, l]) => ({ label: l, value: String(m), selected: m === s.stillWatchingMin })), onPick: (v) => updateSettings({ stillWatchingMin: +v }) }])}
            />
          </div>
          <div class="set-group">
            <h3>Interface</h3>
            <SetRow label="Reduce motion" hint="Disables Ken Burns backdrops and page animations." value={s.reduceMotion ? 'On' : 'Off'} onClick={() => updateSettings({ reduceMotion: !s.reduceMotion })} />
            <SetRow
              label="Time zone"
              hint={`Clock and "Ends at" times. Auto uses the server's zone${serverTz.value ? ` (${tzLabel(serverTz.value)})` : ''}; this device reports ${tzLabel(clientTz)}.`}
              value={s.timeZone === 'auto' || !s.timeZone ? `Auto · ${tzLabel(activeTz.value)}` : tzLabel(s.timeZone)}
              fkey="set-tz"
              onClick={() =>
                openPicker([
                  {
                    title: 'Time zone',
                    options: [
                      { label: 'Auto (server)', value: 'auto', sub: serverTz.value ? tzLabel(serverTz.value) : undefined, selected: s.timeZone === 'auto' || !s.timeZone },
                      ...TIME_ZONES.map(([z, l]) => ({ label: l, value: z, sub: fmtTimeIn(z), selected: s.timeZone === z })),
                    ],
                    onPick: (v) => updateSettings({ timeZone: v }),
                  },
                ])
              }
            />
            <SetRow
              label="Clock"
              hint='Time format for the clock and "Ends at".'
              value={s.clock === '12h' ? '12-hour' : '24-hour'}
              fkey="set-clock"
              onClick={() => updateSettings({ clock: s.clock === '12h' ? '24h' : '12h' })}
            />
            {sideInfo.value && (
              <SetRow
                label="Open on"
                hint="Which side the app starts on. Switch any time with the View button or the Dash pill."
                value={sideInfo.value.startSide === 'dash' ? 'Dash' : 'Media'}
                fkey="set-startside"
                onClick={() => setStartSide(sideInfo.value?.startSide === 'dash' ? 'media' : 'dash')}
              />
            )}
          </div>
          {!noPageServer() && (
            <div class="set-group">
              <h3>Remote</h3>
              <SetRow
                label="Phone remote"
                hint="Control this screen from your phone: D-pad, swipe pad, buttons and typing. Pair with a code."
                value={remotes.value?.length ? `${remotes.value.length} paired` : 'Pair a phone'}
                fkey="set-remote"
                onClick={() => openRemoteDialog()}
              />
            </div>
          )}
          <div class="set-group">
            <h3>Account</h3>
            {uiServers.value && (
              <SetRow
                label="JellyShell server"
                hint="Page server for Requests, Downloads and subtitle tools. Change or clear it here; the app reloads."
                value={uiServerLabel('media')}
                fkey="set-uiserver"
                onClick={() => openUiServerDialog('media')}
              />
            )}
            {uiServers.value && (sideInfo.value || uiServers.value.dash || uiServers.value.defaults.dash) && (
              <SetRow label="Dash server" hint="Optional TV dashboard (View button)." value={uiServerLabel('dash')} fkey="set-dashserver" onClick={() => openUiServerDialog('dash')} />
            )}
            <SetRow label="Server" value={a?.serverName ? `${a.serverName} · ${a.server.replace(/^https?:\/\//, '')}` : a?.server ?? ''} onClick={() => {}} />
            <SetRow label="Signed in as" value={a?.userName ?? ''} onClick={() => {}} />
            <SetRow
              label="Sign out"
              value=""
              onClick={() =>
                openPicker([
                  {
                    title: 'Sign out of JellyShell?',
                    options: [
                      { label: 'Cancel', value: 'no', selected: true },
                      { label: 'Sign out', value: 'yes' },
                    ],
                    onPick: (v) => v === 'yes' && logout(),
                  },
                ])
              }
            />
          </div>
          <div class="set-group">
            <h3>About</h3>
            <SetRow
              label={`JellyShell ${VERSION}`}
              value={isNative ? 'Xbox shell' : 'Browser (mock player)'}
              hint={`Codecs (${capsSource()}): ${capabilities.video.join(', ')} · audio ${capabilities.audioNative.join(', ')} + ${capabilities.audioFfmpeg.join(', ')}`}
              onClick={() => {}}
            />
            <SetRow label="Device ID" value={DEVICE_ID.slice(0, 22)} onClick={() => {}} />
          </div>
        </div>
      </div>
      <UiServerDialog />
      <RemoteDialog />
    </div>
  );
}
