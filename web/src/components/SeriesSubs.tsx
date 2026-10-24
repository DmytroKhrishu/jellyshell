// "Download subtitles…" for a whole season or series (series detail page, admins only).
// The page server runs the job in the background (web-poc/subs_proxy.py, one episode at a time, only episodes
// that have no subtitle in that language, never replacing a file). This module shows the picker and a small
// non-focusable progress pill; the user keeps browsing. The pill lives in its own render root so no shared
// App.tsx edit is needed.
import { render } from 'preact';
import { signal } from '@preact/signals';
import { Item } from '../lib/jellyfin';
import { SeriesJob, SeriesPlan, seriesPlan, startSeriesSubs, seriesJob, cancelSeriesJob, lang2Name, LANG3TO2 } from '../lib/subs';
import { settings } from '../lib/settings';
import { invalidate } from '../lib/datasync';
import { log } from '../lib/log';
import { Column, dialog, openPicker, showToast } from './Dialog';
import { Icon } from './icons';
import '../styles/series-subs.css';

export const subsJob = signal<SeriesJob | null>(null);
let pollTimer: number | undefined;

function prefLang() {
  return LANG3TO2[settings.value.subLang] ?? 'en'; // 'off' / '' (forced only) fall back to English
}

/** Open the picker for `series`; `seasonId` = the Jellyfin season shown on the page (the "This season" row). */
export function openSeriesSubs(series: Item, seasonId?: string, lang = prefLang()) {
  ensureHost();
  // Instant feedback: the plan takes a second (Sonarr + Bazarr + Jellyfin lookups).
  openPicker([{ title: 'Download subtitles', icon: 'findSubs', options: [{ label: 'Checking episodes…', value: 'wait', icon: 'busy', action: true, keep: true }], onPick: () => {} }]);
  const mine = dialog.value;
  seriesPlan(series.Id, lang)
    .then((plan) => {
      if (plan.job) track(plan.job);
      if (dialog.value !== mine) return; // closed (B) while loading
      openPicker(columns(series, seasonId, plan));
    })
    .catch((e) => {
      log('series subs plan failed', String(e));
      if (dialog.value === mine) {
        openPicker([{ title: 'Download subtitles', icon: 'findSubs', note: String(e?.message ?? e), options: [], onPick: () => {} }]);
      }
    });
}

function columns(series: Item, seasonId: string | undefined, plan: SeriesPlan): Column[] {
  const name = lang2Name(plan.language);
  const job = subsJob.value && subsJob.value.state === 'running' ? subsJob.value : null;
  const season = plan.seasons.find((s) => s.jellyfinId === seasonId) ?? null;
  const cols: Column[] = [];
  if (job) {
    cols.push({
      title: 'Download subtitles',
      icon: 'findSubs',
      note: `Running: ${job.seriesName}${job.season !== null ? ` season ${job.season}` : ''} · ${job.done}/${job.total}${job.current ? ` · ${job.current}` : ''}`,
      options: [{ label: job.cancel ? 'Stopping after this episode…' : 'Stop after this episode', value: 'stop', action: true, icon: 'close' }],
      onPick: () => {
        cancelSeriesJob(job.id)
          .then((j) => {
            subsJob.value = j;
            showToast('Stopping after this episode');
          })
          .catch((e) => showToast(String(e?.message ?? e)));
      },
    });
    return cols;
  }
  const missingSub = (n: number, of: number) => (n ? `${n} of ${of} missing` : 'All have subtitles');
  cols.push({
    title: `${name} subtitles`,
    icon: 'findSubs',
    note: `Only episodes without ${name} subtitles. Existing files are never replaced. Takes ~10–60 s per episode; you can keep browsing.`,
    options: [
      ...(season
        ? [{ label: season.season === 0 ? 'Specials' : `Season ${season.season}`, value: 'season', sub: missingSub(season.missing, season.episodes), action: true, icon: 'downloads' as const }]
        : []),
      { label: 'Whole series', value: 'all', sub: missingSub(plan.missing, plan.episodes), action: true, icon: 'downloads' as const },
    ],
    onPick: (v) => {
      const s = v === 'season' ? season!.season : null;
      const n = v === 'season' ? season!.missing : plan.missing;
      if (!n) return showToast(`Every episode already has ${name} subtitles`);
      startSeriesSubs(series.Id, s, plan.language)
        .then((j) => {
          track(j);
          showToast(`Downloading ${name} subtitles for ${j.total} episode${j.total === 1 ? '' : 's'}`);
        })
        .catch((e) => showToast(String(e?.message ?? e), 5000));
    },
  });
  if (plan.languages.length > 1) {
    cols.push({
      title: 'Language',
      icon: 'subtitles',
      // Action rows: a plain pick would close/overwrite the freshly reopened picker. Check icon marks the current one.
      options: plan.languages.map((l) => ({ label: l.name, value: 'lang-' + l.code2, action: true, icon: l.code2 === plan.language ? ('check' as const) : ('subtitles' as const) })),
      onPick: (v) => openSeriesSubs(series, seasonId, v.slice(5)), // recount for that language
    });
  }
  return cols;
}

function track(j: SeriesJob) {
  subsJob.value = j;
  window.clearTimeout(pollTimer);
  if (j.state !== 'running') return;
  const tick = () => {
    seriesJob(j.id)
      .then((n) => {
        const prev = subsJob.value;
        subsJob.value = n;
        if (prev && n.created.length > prev.created.length) invalidate('series subs', 1500); // new tracks show up as they land
        if (n.state === 'running') pollTimer = window.setTimeout(tick, 3000);
        else finished(n);
      })
      .catch((e) => {
        log('series subs poll failed', String(e));
        if (e?.status === 404) subsJob.value = null; // page server restarted: the job is gone
        else pollTimer = window.setTimeout(tick, 6000);
      });
  };
  pollTimer = window.setTimeout(tick, 3000);
}

function finished(j: SeriesJob) {
  const parts = [`${j.created.length} downloaded`];
  const notFound = j.failed.length;
  if (notFound) parts.push(`${notFound} not found`);
  if (j.skipped.length) parts.push(`${j.skipped.length} already had subtitles`);
  showToast(`${j.languageName} subtitles${j.state === 'cancelled' ? ' (stopped)' : ''}: ${parts.join(', ')}`, 7000);
  log('series subs done', j.id, j.state, { created: j.created, failed: j.failed, skipped: j.skipped });
  invalidate('series subs done', 1500);
  window.setTimeout(() => {
    if (subsJob.value?.id === j.id) subsJob.value = null;
  }, 1500);
}

function JobPill() {
  const j = subsJob.value;
  if (!j || j.state !== 'running') return null;
  return (
    <div class="ssub-pill" role="status">
      <Icon name="busy" class="ssub-spin" />
      <span>
        Downloading subtitles {j.done}/{j.total}
        <span class="ssub-sub">
          {j.seriesName}
          {j.season !== null ? ` · Season ${j.season}` : ''}
        </span>
      </span>
    </div>
  );
}

let host: HTMLElement | null = null;
function ensureHost() {
  if (host) return;
  host = document.createElement('div');
  host.id = 'series-subs-host';
  document.body.appendChild(host);
  render(<JobPill />, host);
}
