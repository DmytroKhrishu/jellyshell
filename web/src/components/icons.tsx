// App icon set: Lucide (ISC licence, https://lucide.dev, see web/THIRD_PARTY.md), vendored through the
// `lucide-preact` npm package and bundled at build time (no CDN: the Xbox must work offline).
// Only the icons imported here end up in the bundle (named imports + sideEffects:false = tree-shaken).
// Every icon is an inline SVG using currentColor; size comes from CSS (.ico = 1.15em of the parent's font size),
// so the same component scales with TV rem sizes, desktop and the phone layout.
import type { ComponentType } from 'preact';
import '../styles/icons.css';
import {
  House, Film, Tv, Search, Ellipsis, CirclePlus, Download, Settings, Play, Pause, Info, AudioLines, Captions, ListVideo,
  SkipForward, RotateCcw, Check, Heart, CircleCheck, ChevronRight, ChevronLeft, ChevronDown, Star, FileSearch, TimerReset,
  Volume2, Moon, CircleAlert, CircleDashed, LoaderCircle, Clock, ChartPie, Trash, Eye, Clapperboard, ArrowDownToLine, Hourglass,
  Undo2, Sparkles, X, Sun, Contrast, LayoutDashboard, Server, Maximize, Minimize, CalendarDays, Ticket, MonitorPlay, Disc3,
  User, MapPin, Cake, ChevronUp, Library, SlidersHorizontal, Smartphone, Keyboard, Menu, Copy, ArrowLeft, Gamepad2, Hand, WifiOff,
  CornerDownLeft, Circle,
} from 'lucide-preact';

export type IconComp = ComponentType<any>;

export const I = {
  home: House,
  movies: Film,
  shows: Tv,
  search: Search,
  more: Ellipsis,
  requests: CirclePlus,
  downloads: Download,
  settings: Settings,
  play: Play,
  pause: Pause,
  info: Info,
  fullscreen: Maximize,
  fullscreenExit: Minimize,
  audio: AudioLines,
  subtitles: Captions,
  episodes: ListVideo,
  next: SkipForward,
  restart: RotateCcw,
  check: Check,
  heart: Heart,
  watched: CircleCheck,
  unwatched: Circle,
  chevRight: ChevronRight,
  chevLeft: ChevronLeft,
  chevDown: ChevronDown,
  star: Star,
  findSubs: FileSearch,
  fixTiming: TimerReset,
  boost: Volume2,
  night: Moon,
  alert: CircleAlert,
  pending: CircleDashed,
  busy: LoaderCircle,
  clock: Clock,
  partial: ChartPie,
  trash: Trash,
  open: Eye,
  trailer: Clapperboard,
  importing: ArrowDownToLine,
  queued: Hourglass,
  undo: Undo2,
  sparkles: Sparkles,
  close: X,
  brightness: Sun,
  contrast: Contrast,
  dash: LayoutDashboard,
  server: Server,
  calendar: CalendarDays,
  cinema: Ticket,
  digital: MonitorPlay,
  physical: Disc3,
  person: User,
  place: MapPin,
  born: Cake,
  chevUp: ChevronUp,
  library: Library,
  options: SlidersHorizontal,
  phone: Smartphone,
  keyboard: Keyboard,
  menuBtn: Menu,
  viewBtn: Copy,
  back: ArrowLeft,
  gamepad: Gamepad2,
  touchpad: Hand,
  offline: WifiOff,
  enter: CornerDownLeft,
} satisfies Record<string, IconComp>;

export type IconName = keyof typeof I;

/** <Icon name="play" /> — decorative (aria-hidden); pair it with a text label or an aria-label on the button. */
export function Icon({ name, class: cls, fill, stroke }: { name: IconName; class?: string; fill?: boolean; stroke?: number }) {
  const C = I[name];
  return <C class={'ico' + (cls ? ' ' + cls : '')} aria-hidden="true" strokeWidth={stroke ?? 2} fill={fill ? 'currentColor' : 'none'} />;
}
