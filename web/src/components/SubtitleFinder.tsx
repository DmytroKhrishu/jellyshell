// "Find subtitles" side panel (player + detail page): Bazarr manual search, candidates sorted by score,
// releases matching the video file highlighted. A downloads, B cancels a running search / closes, LT/RT page.
// Opened through the global `finder` signal so it renders outside any transformed page (see App.tsx host).
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Item, episodeLabel } from '../lib/jellyfin';
import { pushHandler } from '../lib/input';
import { current, focusEl, focusFirst, move, page } from '../lib/focus';
import { Candidate, SearchResult, searchSubs, downloadSub, lang2Name, LANG3TO2, fmtMin } from '../lib/subs';
import { settings } from '../lib/settings';
import { trackPref } from '../lib/trackmem';
import { showToast } from './Dialog';
import { log } from '../lib/log';
import '../styles/subs.css';

export interface FinderReq {
  item: Item;
  /** Called after a successful download with the new subtitle's Jellyfin stream index (null if Jellyfin hasn't listed it yet). */
  onDownloaded: (jellyfinIndex: number | null, fileName: string) => void;
  onClose?: () => void;
}
export const finder = signal<FinderReq | null>(null);
let invoker: HTMLElement | null = null;

export function openFinder(req: FinderReq) {
  invoker = document.activeElement as HTMLElement;
  finder.value = req;
}
function closeFinder() {
  const f = finder.value;
  finder.value = null;
  f?.onClose?.();
  requestAnimationFrame(() => {
    if (invoker?.isConnected) focusEl(invoker);
  });
}

export function SubtitleFinderHost() {
  const f = finder.value;
  return f ? <SubtitleFinder key={f.item.Id} req={f} /> : null;
}

function SubtitleFinder({ req }: { req: FinderReq }) {
  const it = req.item;
  const [res, setRes] = useState<SearchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState<string | null>(null); // candidate key being downloaded
  const [confirm, setConfirm] = useState<string | null>(null); // candidate key awaiting a second A (would overwrite a file)
  const langs = useMemo(() => {
    const mem = trackPref(it)?.sub; // the show's remembered subtitle language first, then Settings
    const pref = (mem && mem !== 'off' && LANG3TO2[mem.lang]) || LANG3TO2[settings.value.subLang] || '';
    return Array.from(new Set([pref, 'en'].filter(Boolean)));
  }, []);
  const [lang, setLang] = useState(langs[0]);
  const ref = useRef<HTMLDivElement>(null);
  const ctl = useRef<AbortController | null>(null);

  const run = () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setRes(null);
    setErr(null);
    setElapsed(0);
    const t0 = performance.now();
    const tick = window.setInterval(() => setElapsed(Math.round((performance.now() - t0) / 1000)), 1000);
    searchSubs(it.Id, c.signal)
      .then((r) => {
        setRes(r);
        log('subs search', { item: it.Name, n: r.candidates.length, s: r.seconds });
      })
      .catch((e) => {
        if (c.signal.aborted) return;
        log('subs search failed', String(e?.message ?? e));
        setErr(String(e?.message ?? e));
      })
      .finally(() => window.clearInterval(tick));
  };
  useEffect(() => {
    run();
    return () => ctl.current?.abort();
  }, [it.Id]);

  const list = (res?.candidates ?? []).filter((c) => c.language === lang);
  const other = (res?.candidates ?? []).length - list.length;

  // Focus: the first candidate when results arrive; Retry on error; else the panel's first focusable.
  useEffect(() => {
    requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      const cur = current();
      if (cur && root.contains(cur) && !cur.classList.contains('sf-lang')) return;
      if (res && list.length) focusEl(root.querySelector<HTMLElement>('.sf-item'), { instant: true });
      else if (!cur || !root.contains(cur)) focusFirst(root, { instant: true });
    });
  }, [res, err, lang]);

  const download = async (c: Candidate, key: string) => {
    if (busy) return;
    if (c.replaces && confirm !== key) {
      setConfirm(key); // Bazarr names files by language: this would overwrite the current subtitle
      return;
    }
    setConfirm(null);
    setBusy(key);
    try {
      const r = await downloadSub(it.Id, c);
      log('subs downloaded', { item: it.Name, file: r.fileName, index: r.jellyfinIndex });
      showToast(r.replacedExisting ? 'Subtitles replaced' : 'Subtitles downloaded', 2500);
      finder.value = null;
      req.onDownloaded(r.jellyfinIndex, r.fileName);
      requestAnimationFrame(() => invoker?.isConnected && focusEl(invoker));
    } catch (e: any) {
      log('subs download failed', String(e?.message ?? e));
      showToast('Download failed: ' + String(e?.message ?? e), 4000);
      setBusy(null);
    }
  };

  useEffect(
    () =>
      pushHandler((e) => {
        const a = e.action;
        if (a === 'back' || a === 'menu' || a === 'view') {
          if (e.repeat) return true;
          if (busy) return true; // can't cancel a download midway
          if (confirm) {
            setConfirm(null);
            return true;
          }
          ctl.current?.abort();
          closeFinder();
          return true;
        }
        if (a === 'lt' || a === 'rt') {
          page(a === 'lt' ? 'up' : 'down');
          return true;
        }
        if (a === 'lb' || a === 'rb') {
          if (e.repeat || langs.length < 2) return true;
          const i = langs.indexOf(lang);
          setLang(langs[(i + (a === 'rb' ? 1 : langs.length - 1)) % langs.length]);
          return true;
        }
        if (a === 'up' || a === 'down' || a === 'left' || a === 'right') {
          if (confirm) setConfirm(null);
          move(a);
          return true;
        }
        if (a === 'select') {
          if (!e.repeat) current()?.click();
          return true;
        }
        return true; // modal: swallow X/Y
      }),
    [busy, lang, langs, confirm],
  );

  const f = res?.file;
  const head = it.Type === 'Episode' ? `${it.SeriesName} · ${episodeLabel(it)}` : it.Name;
  return (
    <div class="sf-wrap" onClick={(e) => e.target === e.currentTarget && !busy && (ctl.current?.abort(), closeFinder())}>
      <aside class="sf" data-scope ref={ref}>
        <div class="sf-head">
          <div class="sf-title">Find subtitles</div>
          <div class="sf-item-name">{head}</div>
          {f && (
            <div class="sf-file">
              Your file
              {[f.sourceLabel, f.group, f.resolution, f.runtimeSeconds ? fmtMin(f.runtimeSeconds) : null, f.fps ? `${f.fps} fps` : null].filter(Boolean).map((x) => (
                <span class="sf-tag" key={x!}>{x}</span>
              ))}
            </div>
          )}
          {res?.current?.some((c) => c.cut?.likelyOtherCut) && (
            <div class="sf-warn">
              {(() => {
                const c = res.current!.find((x) => x.cut?.likelyOtherCut)!.cut!;
                return `Current subtitles run to ${fmtMin(c.subtitleEndSeconds)} but this video is ${fmtMin(c.videoSeconds)}: they were made for a different cut. Pick a release with the same runtime.`;
              })()}
            </div>
          )}
        </div>
        {langs.length > 1 && (
          <div class="sf-langs" data-group="sf-langs">
            {langs.map((l) => (
              <div key={l} class={'pill focusable sf-lang' + (l === lang ? ' selected' : '')} tabIndex={-1} onClick={() => setLang(l)}>
                {lang2Name(l)}
                {res && <span class="sf-count">{res.candidates.filter((c) => c.language === l).length}</span>}
              </div>
            ))}
          </div>
        )}
        {!res && !err && (
          <div class="sf-state">
            <div class="spinner" />
            <div class="sf-state-main">Searching subtitle providers…</div>
            <div class="sf-state-sub">{elapsed > 0 ? `${elapsed} s · ` : ''}This can take up to a minute. B to cancel.</div>
          </div>
        )}
        {err && (
          <div class="sf-state">
            <div class="sf-state-main">Search failed</div>
            <div class="sf-state-sub">{err}</div>
            <div class="btn focusable" tabIndex={-1} data-autofocus onClick={run} style={{ marginTop: '1.2rem' }}>
              Try again
            </div>
          </div>
        )}
        {res && list.length === 0 && (
          <div class="sf-state">
            <div class="sf-state-main">No {lang2Name(lang)} subtitles found</div>
            <div class="sf-state-sub">
              {other > 0 ? `${other} in other languages. ` : ''}Bazarr searched its enabled providers in {res.seconds} s.
            </div>
            <div class="btn focusable" tabIndex={-1} data-autofocus onClick={run} style={{ marginTop: '1.2rem' }}>
              Search again
            </div>
          </div>
        )}
        {res && list.length > 0 && (
          <div class="sf-list" data-vscroll data-margintop="2rem" data-marginbottom="2rem" data-group="sf-list">
            <div class="vtrack">
              {list.map((c, i) => {
                const key = c.provider + ':' + i;
                const name = c.releases.find((r) => !/^[^.\-]+ \(\d{4}\) S\d+E\d+$/i.test(r)) ?? c.releases[0] ?? 'Unnamed release';
                const more = c.releases.filter((r) => r !== name).length;
                return (
                  <div
                    key={key}
                    class={'sf-item focusable' + (c.groupMatch ? ' match' : '') + (busy === key ? ' busy' : '')}
                    tabIndex={-1}
                    onClick={() => download(c, key)}
                  >
                    <div class="sf-row1">
                      <span class="sf-rel">{name}</span>
                      {more > 0 && <span class="sf-more">+{more}</span>}
                      <span class="sf-score">{c.score}%</span>
                    </div>
                    <div class="sf-row2">
                      <span class="sf-prov">{c.provider}</span>
                      {c.fps && <span class={'sf-badge' + (f?.fps && Math.abs(c.fps - f.fps) > 0.05 ? ' dim' : '')}>{c.fps} fps</span>}
                      {c.groupMatch && <span class="sf-badge good">Same release group</span>}
                      {c.sourceMatch && <span class="sf-badge good">Same source</span>}
                      {c.hi && <span class="sf-badge">HI</span>}
                      {c.forced && <span class="sf-badge">Forced</span>}
                      {c.replaces && <span class="sf-badge dim">Replaces current</span>}
                      {confirm === key && <span class="sf-confirm">Replaces the current file. Press A again to confirm</span>}
                      {busy === key && (
                        <span class="sf-dl">
                          <span class="spinner" /> Downloading…
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <div class="sf-foot">A download · B {res || err ? 'close' : 'cancel'}{langs.length > 1 ? ' · LB/RB language' : ''} · LT/RT page</div>
      </aside>
    </div>
  );
}
