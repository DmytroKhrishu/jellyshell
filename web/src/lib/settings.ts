import { signal, effect } from '@preact/signals';

export type HdrMode = 'off' | 'auto';
export interface Settings {
  hdr: HdrMode;
  matchFrameRate: boolean;
  audioLang: string; // '' = file default
  subLang: string; // 'off' | '' (forced/default only) | iso639-2
  reduceMotion: boolean;
  timeZone: string; // 'auto' = the page server's zone, else an IANA zone
  clock: '24h' | '12h';
  stillWatchingMin: number; // "Are you still watching?" idle limit for short items, 0 = off
  skipIntros: 'ask' | 'seen' | 'always'; // auto-skip intros: never / once the show's intro was watched once / always
  nextAutoplay: number; // Next Episode countdown in s once the credits start; 0 = off, -1 = wait for the end of the file
}

const KEY = 'jellyshell.settings.v1';
const DEFAULTS: Settings = {
  hdr: 'off',
  matchFrameRate: true,
  audioLang: '',
  subLang: 'off',
  reduceMotion: false,
  timeZone: 'auto',
  clock: '24h',
  stillWatchingMin: 60,
  skipIntros: 'seen',
  nextAutoplay: 5,
};

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export const settings = signal<Settings>(load());
effect(() => {
  localStorage.setItem(KEY, JSON.stringify(settings.value));
  document.documentElement.classList.toggle('reduce-motion', settings.value.reduceMotion);
});

export function updateSettings(p: Partial<Settings>) {
  settings.value = { ...settings.value, ...p };
}

export const LANGS: [string, string][] = [
  ['eng', 'English'],
  ['ukr', 'Ukrainian'],
  ['rus', 'Russian'],
  ['ces', 'Czech'],
  ['deu', 'German'],
  ['fra', 'French'],
  ['spa', 'Spanish'],
  ['ita', 'Italian'],
  ['pol', 'Polish'],
  ['jpn', 'Japanese'],
  ['kor', 'Korean'],
];

export function langName(code?: string) {
  if (!code) return 'Unknown';
  const hit = LANGS.find(([c]) => c === code || (code === 'cze' && c === 'ces') || (code === 'ger' && c === 'deu') || (code === 'fre' && c === 'fra'));
  return hit ? hit[1] : code.toUpperCase();
}
