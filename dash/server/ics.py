"""Minimal iCalendar (RFC 5545) reader for the Dash calendar. Stdlib only.

    cal = parse(text)                                  # one feed -> Calendar (name, color, tz, events)
    expand(cal, start, end, tz, name=..., color=...)   # -> instance dicts, the GET /api/calendar event shape

Covers what Google Calendar, iCloud and Outlook publish: line unfolding, VEVENT, DTSTART/DTEND/DURATION, all-day
(VALUE=DATE), UTC / TZID (IANA via zoneinfo, common Windows names) / floating times, RRULE (DAILY, WEEKLY, MONTHLY,
YEARLY with INTERVAL, COUNT, UNTIL, BYDAY incl. 1MO / -1FR, BYMONTHDAY, BYMONTH, BYSETPOS, WKST), RDATE, EXDATE,
RECURRENCE-ID overrides and STATUS:CANCELLED. Anything else (BYHOUR, BYWEEKNO, HOURLY rules, RANGE=THISANDFUTURE, ...)
degrades gracefully: the series shows its first instance only, and the reason is logged once.
"""
import calendar as _cal
import re
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

UTC = timezone.utc
WEEKDAYS = {'MO': 0, 'TU': 1, 'WE': 2, 'TH': 3, 'FR': 4, 'SA': 5, 'SU': 6}
MAX_PERIODS = 20000  # recurrence periods walked per series (daily for ~55 years)
MEETING_RX = re.compile(r'https://(?:[\w-]+\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|whereby\.com|'
                        r'facetime\.apple\.com)/[^\s<>"\')\\]+')

# Windows zone names Outlook / Exchange put in TZID (CLDR windowsZones, territory 001). Unknown ones fall back to the
# calendar's / household zone.
WINDOWS_TZ = {
    'UTC': 'UTC', 'Coordinated Universal Time': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
    'W. Europe Standard Time': 'Europe/Berlin', 'Central Europe Standard Time': 'Europe/Budapest',
    'Central European Standard Time': 'Europe/Warsaw', 'Romance Standard Time': 'Europe/Paris',
    'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kyiv', 'GTB Standard Time': 'Europe/Bucharest',
    'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul', 'Israel Standard Time': 'Asia/Jerusalem',
    'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
    'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
    'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax', 'Canada Central Standard Time': 'America/Regina',
    'E. South America Standard Time': 'America/Sao_Paulo', 'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai',
    'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'Singapore Standard Time': 'Asia/Singapore',
    'AUS Eastern Standard Time': 'Australia/Sydney', 'E. Australia Standard Time': 'Australia/Brisbane',
    'W. Australia Standard Time': 'Australia/Perth', 'New Zealand Standard Time': 'Pacific/Auckland', 'Arabian Standard Time': 'Asia/Dubai',
    'South Africa Standard Time': 'Africa/Johannesburg',
}

_warned: set = set()


def warn_once(key, msg):
    if key not in _warned:
        _warned.add(key)
        print(f'ics: {msg}', flush=True)


# ---------------------------------------------------------------- lexing
def unfold(text):
    """Content lines with RFC 5545 folding (CRLF + space/tab) undone."""
    out: list = []
    for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        if line[:1] in (' ', '\t') and out:
            out[-1] += line[1:]
        elif line.strip():
            out.append(line)
    return out


_NAME = re.compile(r'[A-Za-z0-9-]+')


def parse_line(line):
    """'DTSTART;TZID="Europe/Prague":20261102T093000' -> ('DTSTART', {'TZID': 'Europe/Prague'}, '20261102T093000')."""
    m = _NAME.match(line)
    if not m:
        return None
    name, i, n, params = m.group(0).upper(), m.end(), len(line), {}
    while i < n and line[i] == ';':
        m = _NAME.match(line, i + 1)
        if not m or m.end() >= n or line[m.end()] != '=':
            return None
        pname, i, vals = m.group(0).upper(), m.end() + 1, []
        while True:
            if i < n and line[i] == '"':
                j = line.find('"', i + 1)
                if j < 0:
                    return None
                vals.append(line[i + 1:j])
                i = j + 1
            else:
                j = i
                while j < n and line[j] not in ';:,':
                    j += 1
                vals.append(line[i:j])
                i = j
            if i < n and line[i] == ',':
                i += 1
                continue
            break
        params[pname] = ','.join(vals)
    if i >= n or line[i] != ':':
        return None
    return name, params, line[i + 1:]


def unescape(v):
    return re.sub(r'\\([\\;,nN])', lambda m: '\n' if m.group(1) in 'nN' else m.group(1), v)


# ---------------------------------------------------------------- model
class Event:
    """One VEVENT: props maps a property name to a list of (params, value)."""

    def __init__(self):
        self.props: dict = {}

    def get(self, name, default=None):
        v = self.props.get(name)
        return v[0] if v else default

    def text(self, name):
        p = self.get(name)
        return unescape(p[1]).strip() if p else ''


class Calendar:
    def __init__(self):
        self.name = ''
        self.color = ''
        self.tz = None  # X-WR-TIMEZONE: zone for floating times
        self.events: list = []


def parse(text):
    """Feed text -> Calendar. Unparseable lines are skipped; nested components (VALARM) are ignored."""
    cal, stack = Calendar(), []
    for line in unfold(text):
        p = parse_line(line)
        if not p:
            continue
        name, params, value = p
        if name == 'BEGIN':
            comp = value.strip().upper()
            stack.append(Event() if comp == 'VEVENT' and not any(isinstance(s, Event) for s in stack) else comp)
            continue
        if name == 'END':
            if stack:
                top = stack.pop()
                if isinstance(top, Event):
                    cal.events.append(top)
            continue
        top = stack[-1] if stack else None
        if isinstance(top, Event):
            top.props.setdefault(name, []).append((params, value))
        elif top == 'VCALENDAR':
            if name == 'X-WR-CALNAME':
                cal.name = unescape(value).strip()
            elif name == 'X-WR-TIMEZONE':
                cal.tz = resolve_tz(value.strip(), None)
            elif name == 'X-APPLE-CALENDAR-COLOR' and re.fullmatch(r'#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?', value.strip()):
                cal.color = value.strip()[:7].upper()
    return cal


# ---------------------------------------------------------------- values
def resolve_tz(tzid, default):
    tzid = (tzid or '').strip().strip('"')
    if not tzid:
        return default
    for cand in (tzid, WINDOWS_TZ.get(tzid), re.sub(r'^.*?/(?=(?:Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)/)', '', tzid)):
        if not cand:
            continue
        try:
            return ZoneInfo(cand)
        except (ZoneInfoNotFoundError, ValueError):
            continue
    warn_once('tz:' + tzid, f'unknown TZID {tzid!r}, using the calendar/household zone')
    return default


_DT = re.compile(r'(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?')


def parse_value(value, params, default_tz):
    """DATE -> date; DATE-TIME -> aware datetime (UTC for Z, TZID zone, else default_tz for floating). None if invalid."""
    m = _DT.fullmatch(value.strip())
    if not m:
        return None
    y, mo, d, hh, mi, ss, z = m.groups()
    try:
        if hh is None or params.get('VALUE', '').upper() == 'DATE':
            return date(int(y), int(mo), int(d))
        tz = UTC if z else resolve_tz(params.get('TZID'), default_tz) if params.get('TZID') else default_tz
        return datetime(int(y), int(mo), int(d), int(hh), int(mi), min(59, int(ss or 0)), tzinfo=tz)
    except ValueError:
        return None


def parse_list(prop, default_tz):
    params, value = prop
    if params.get('VALUE', '').upper() == 'PERIOD':
        value = ','.join(v.split('/', 1)[0] for v in value.split(','))
    return [x for x in (parse_value(v, params, default_tz) for v in value.split(',') if v.strip()) if x is not None]


_DUR = re.compile(r'([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?')


def parse_duration(value):
    m = _DUR.fullmatch(value.strip().upper())
    if not m or value.strip().upper() in ('P', 'PT', '+P', '-P'):
        return None
    sign, w, d, h, mi, s = m.groups()
    td = timedelta(weeks=int(w or 0), days=int(d or 0), hours=int(h or 0), minutes=int(mi or 0), seconds=int(s or 0))
    return -td if sign == '-' else td


def key_of(x):
    """Instance identity for EXDATE / RECURRENCE-ID matching: an all-day date, or the UTC epoch of a timed start."""
    return ('d', x.isoformat()) if not isinstance(x, datetime) else ('t', int(x.timestamp()))


# ---------------------------------------------------------------- recurrence
class Rule:
    SUPPORTED = {'FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'BYSETPOS', 'WKST'}

    def __init__(self, value, default_tz):
        parts = {}
        for p in value.split(';'):
            k, sep, v = p.partition('=')
            if sep:
                parts[k.strip().upper()] = v.strip()
        self.freq = parts.get('FREQ', '').upper()
        extra = sorted(set(parts) - self.SUPPORTED)
        self.unsupported = (f'FREQ={self.freq}' if self.freq not in ('DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY') else
                            ','.join(extra) if extra else None)
        try:
            self.interval = max(1, int(parts.get('INTERVAL', '1')))
            self.count = int(parts['COUNT']) if 'COUNT' in parts else None
            self.bymonthday = [int(x) for x in parts['BYMONTHDAY'].split(',')] if parts.get('BYMONTHDAY') else []
            self.bymonth = [int(x) for x in parts['BYMONTH'].split(',')] if parts.get('BYMONTH') else []
            self.bysetpos = [int(x) for x in parts['BYSETPOS'].split(',')] if parts.get('BYSETPOS') else []
            self.byday = []
            for x in filter(None, parts.get('BYDAY', '').upper().split(',')):
                m = re.fullmatch(r'([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)', x.strip())
                if not m:
                    raise ValueError(x)
                self.byday.append((int(m.group(1)) if m.group(1) else None, WEEKDAYS[m.group(2)]))
        except ValueError as e:
            self.unsupported = f'bad value {e}'
            return
        self.wkst = WEEKDAYS.get(parts.get('WKST', 'MO').upper(), 0)
        self.until = parse_value(parts['UNTIL'], {}, default_tz) if parts.get('UNTIL') else None
        if self.freq in ('DAILY', 'WEEKLY') and any(n for n, _ in self.byday):
            self.unsupported = 'ordinal BYDAY in a DAILY/WEEKLY rule'


def _days_in_month(y, m):
    return _cal.monthrange(y, m)[1]


def _month_candidates(rule, y, m, anchor_day):
    """Dates in month y-m selected by BYMONTHDAY / BYDAY (intersection when both), else the anchor day."""
    n = _days_in_month(y, m)
    md = set()
    for x in rule.bymonthday:
        d = x if x > 0 else n + 1 + x
        if 1 <= d <= n:
            md.add(d)
    wd = set()
    for nth, w in rule.byday:
        days = [d for d in range(1, n + 1) if date(y, m, d).weekday() == w]
        if nth is None:
            wd.update(days)
        elif -len(days) <= nth <= len(days) and nth != 0:
            wd.add(days[nth - 1] if nth > 0 else days[nth])
    if rule.bymonthday and rule.byday:
        sel = md & wd
    elif rule.bymonthday or rule.byday:
        sel = md | wd
    else:
        sel = {anchor_day} if anchor_day <= n else set()
    return [date(y, m, d) for d in sorted(sel)]


def _year_ordinal_candidates(rule, y):
    """YEARLY;BYDAY=20MO without BYMONTH: the nth weekday of the whole year."""
    out = set()
    for nth, w in rule.byday:
        days = [date(y, 1, 1) + timedelta(i) for i in range(366 if _cal.isleap(y) else 365)]
        days = [d for d in days if d.weekday() == w]
        if nth is None:
            out.update(days)
        elif -len(days) <= nth <= len(days) and nth != 0:
            out.add(days[nth - 1] if nth > 0 else days[nth])
    return sorted(out)


def _setpos(rule, cands):
    if not rule.bysetpos or not cands:
        return cands
    out = set()
    for p in rule.bysetpos:
        if 0 < p <= len(cands):
            out.add(cands[p - 1])
        elif -len(cands) <= p < 0:
            out.add(cands[p])
    return sorted(out)


def _period(rule, start, k):
    """(first day of period k, candidate dates in it) for a rule anchored at local date `start`."""
    iv = rule.interval
    if rule.freq == 'DAILY':
        d = start + timedelta(days=k * iv)
        ok = ((not rule.bymonth or d.month in rule.bymonth)
              and (not rule.bymonthday or d.day in rule.bymonthday or d.day - _days_in_month(d.year, d.month) - 1 in rule.bymonthday)
              and (not rule.byday or d.weekday() in {w for _, w in rule.byday}))
        return d, [d] if ok else []
    if rule.freq == 'WEEKLY':
        week = start - timedelta(days=(start.weekday() - rule.wkst) % 7) + timedelta(weeks=k * iv)
        wds = [w for _, w in rule.byday] or [start.weekday()]
        days = sorted({week + timedelta(days=(w - rule.wkst) % 7) for w in wds})
        return week, _setpos(rule, [d for d in days if not rule.bymonth or d.month in rule.bymonth])
    if rule.freq == 'MONTHLY':
        mi = start.month - 1 + k * iv
        y, m = start.year + mi // 12, mi % 12 + 1
        first = date(y, m, 1)
        if rule.bymonth and m not in rule.bymonth:
            return first, []
        return first, _setpos(rule, _month_candidates(rule, y, m, start.day))
    # YEARLY
    y = start.year + k * iv
    first = date(y, 1, 1)
    if rule.byday and not rule.bymonth and not rule.bymonthday and any(n for n, _ in rule.byday):
        return first, _setpos(rule, _year_ordinal_candidates(rule, y))
    months = rule.bymonth or (list(range(1, 13)) if rule.bymonthday or rule.byday else [start.month])
    if not (rule.byday or rule.bymonthday):
        c = [date(y, m, start.day) for m in months if start.day <= _days_in_month(y, m)]
    else:
        c = [d for m in months for d in _month_candidates(rule, y, m, start.day)]
    return first, _setpos(rule, sorted(c))


def _skip_periods(rule, start, window_start):
    """Periods that can be skipped without changing the result (only valid without COUNT)."""
    if rule.count is not None or window_start <= start:
        return 0
    days = (window_start - start).days
    per = {'DAILY': 1, 'WEEKLY': 7, 'MONTHLY': 31, 'YEARLY': 366}[rule.freq] * rule.interval  # longest period: never overshoots
    return max(0, days // per - 2)


def _beyond_until(rule, inst):
    u = rule.until
    if u is None:
        return False
    if isinstance(inst, datetime):
        return (inst.date() > u) if not isinstance(u, datetime) else inst > u
    return inst > (u.date() if isinstance(u, datetime) else u)


def occurrences(dtstart, rule, window_start, window_end):
    """Rule instances (dates or aware datetimes in dtstart's zone) from dtstart up to window_end (local date bound)."""
    timed = isinstance(dtstart, datetime)
    start = dtstart.date() if timed else dtstart
    t, tz = (dtstart.time(), dtstart.tzinfo) if timed else (None, None)
    last_day = window_end + timedelta(days=1)
    seen = 0
    for k in range(_skip_periods(rule, start, window_start), _skip_periods(rule, start, window_start) + MAX_PERIODS):
        first, cands = _period(rule, start, k)
        if first > last_day:
            return
        for d in cands:
            if d < start:
                continue
            inst = datetime.combine(d, t, tzinfo=tz) if timed else d
            if timed and inst < dtstart:
                continue
            if _beyond_until(rule, inst):
                return
            seen += 1
            if rule.count is not None and seen > rule.count:
                return
            yield inst


# ---------------------------------------------------------------- expansion
def _meeting_url(ev):
    u = ev.text('URL')
    if u and MEETING_RX.match(u):
        return u
    for name in ('X-GOOGLE-CONFERENCE', 'LOCATION', 'DESCRIPTION'):
        m = MEETING_RX.search(ev.text(name))
        if m:
            return m.group(0).rstrip('.,;')
    return None


def _as_out(x, tz):
    """date -> household local midnight; datetime -> same instant in the household zone. ISO 8601 with offset."""
    if isinstance(x, datetime):
        return x.astimezone(tz).isoformat()
    return datetime.combine(x, time(0), tzinfo=tz).isoformat()


def _span(ev, start, default_tz):
    """Length of an event as (timedelta, is_elapsed). All-day lengths are whole days."""
    p = ev.get('DTEND')
    end = parse_value(p[1], p[0], default_tz) if p else None
    if end is not None and type(end) is type(start):
        if isinstance(start, datetime):
            return end.astimezone(UTC) - start.astimezone(UTC)
        return end - start
    p = ev.get('DURATION')
    dur = parse_duration(p[1]) if p else None
    if dur is not None:
        return dur
    return timedelta(days=1) if not isinstance(start, datetime) else timedelta(0)


def _end_of(start, span):
    if isinstance(start, datetime):
        return (start.astimezone(UTC) + span).astimezone(start.tzinfo)
    return start + timedelta(days=max(1, span.days))


def _overlaps(start, end, ws, we, tz):
    s = start if isinstance(start, datetime) else datetime.combine(start, time(0), tzinfo=tz)
    e = end if isinstance(end, datetime) else datetime.combine(end, time(0), tzinfo=tz)
    if e <= s:
        e = s + timedelta(seconds=1)  # zero-length events still show at their start
    return s < we and e > ws


def expand(cal, window_start, window_end, tz, name='', color=''):
    """Instances overlapping [window_start, window_end) (aware datetimes) as Dash event dicts, sorted by start.

    tz is the household zone: all-day events become its local midnights, floating times without X-WR-TIMEZONE use it.
    """
    default_tz = cal.tz or tz
    label = name or cal.name or 'Calendar'
    col = color or cal.color or '#1BADF8'
    overrides: dict = {}
    masters = []
    cancelled = {ev.text('UID') for ev in cal.events if not ev.get('RECURRENCE-ID') and ev.text('STATUS').upper() == 'CANCELLED'}
    for ev in cal.events:
        rid = ev.get('RECURRENCE-ID')
        if rid:
            if rid[0].get('RANGE', '').upper() == 'THISANDFUTURE':
                warn_once('range', 'RECURRENCE-ID;RANGE=THISANDFUTURE treated as a single-instance change')
            r = parse_value(rid[1], rid[0], default_tz)
            if r is not None:
                overrides[(ev.text('UID'), key_of(r))] = ev
        else:
            masters.append(ev)

    out = []

    def emit(ev, start, span):
        if ev.text('STATUS').upper() == 'CANCELLED':
            return
        end = _end_of(start, span)
        if not _overlaps(start, end, window_start, window_end, tz):
            return
        loc = ev.text('LOCATION')
        out.append({'title': ev.text('SUMMARY') or '(no title)', 'start': _as_out(start, tz), 'end': _as_out(end, tz),
                    'calendar': label, 'color': col, 'allDay': not isinstance(start, datetime),
                    'location': loc if loc and not loc.startswith('http') else None, 'url': _meeting_url(ev), 'source': 'ics'})

    ws_local, we_local = window_start.astimezone(tz).date(), window_end.astimezone(tz).date()
    for ev in masters:
        p = ev.get('DTSTART')
        start = parse_value(p[1], p[0], default_tz) if p else None
        if start is None or ev.text('STATUS').upper() == 'CANCELLED':
            continue
        span = _span(ev, start, default_tz)
        uid = ev.text('UID')
        rr = ev.get('RRULE')
        rdates = [x for prop in ev.props.get('RDATE', []) for x in parse_list(prop, default_tz)]
        if not rr and not rdates:
            emit(ev, start, span)
            continue
        excluded = set()
        exdates_d = set()
        for prop in ev.props.get('EXDATE', []):
            for x in parse_list(prop, default_tz):
                excluded.add(key_of(x))
                if not isinstance(x, datetime):
                    exdates_d.add(x)
        insts = {key_of(start): start}
        if rr:
            rule = Rule(rr[1], default_tz)
            if rule.unsupported:
                warn_once('rr:' + rule.unsupported, f'unsupported RRULE part ({rule.unsupported}); showing only the first instance')
            else:
                for x in occurrences(start, rule, ws_local - timedelta(days=1), we_local):
                    insts[key_of(x)] = x
        for x in rdates:
            if type(x) is type(start):
                insts[key_of(x)] = x
        for k, x in sorted(insts.items(), key=lambda kv: kv[1].astimezone(UTC) if isinstance(kv[1], datetime) else
                           datetime.combine(kv[1], time(0), tzinfo=tz)):
            if k in excluded or (isinstance(x, datetime) and x.astimezone(default_tz).date() in exdates_d):
                continue
            if (uid, k) in overrides:
                continue  # emitted below from the override itself (moved, edited or cancelled)
            emit(ev, x, span)
    for (uid, _), ev in overrides.items():
        if uid in cancelled:
            continue
        p = ev.get('DTSTART')
        start = parse_value(p[1], p[0], default_tz) if p else None
        if start is not None:
            emit(ev, start, _span(ev, start, default_tz))
    out.sort(key=lambda e: (datetime.fromisoformat(e['start']).timestamp(), e['title']))
    return out
