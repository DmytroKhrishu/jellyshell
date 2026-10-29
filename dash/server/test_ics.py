"""Tests for dash/server/ics.py. Run from the repo root: python3 -m unittest discover -s dash/server -p 'test_*.py'

The feeds below are written by hand in the shapes Google Calendar, iCloud and Outlook publish.
"""
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ics  # noqa: E402

PRAGUE = ZoneInfo('Europe/Prague')
UTC = timezone.utc


def feed(*events, head=''):
    body = '\r\n'.join(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', head, *events, 'END:VCALENDAR'])
    return '\r\n'.join(line for line in body.split('\r\n') if line)


def win(a, b, tz=PRAGUE):
    return datetime.fromisoformat(a).replace(tzinfo=tz), datetime.fromisoformat(b).replace(tzinfo=tz)


def run(text, a='2026-10-19T00:00', b='2026-11-09T00:00', **kw):
    ws, we = win(a, b)
    return ics.expand(ics.parse(text), ws, we, PRAGUE, **kw)


def utc(s):
    return datetime.fromisoformat(s).astimezone(UTC).strftime('%Y-%m-%dT%H:%MZ')


# Google style: X-WR-CALNAME/TIMEZONE, VTIMEZONE block, TZID times, UTC EXDATE-less override pairs.
GOOGLE_STANDUP = '\r\n'.join([
    'BEGIN:VEVENT',
    'DTSTART;TZID=Europe/Prague:20261019T093000',
    'DTEND;TZID=Europe/Prague:20261019T094500',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261231T225959Z',
    'EXDATE;TZID=Europe/Prague:20261021T093000',
    'DTSTAMP:20261001T000000Z',
    'UID:standup-1@google.com',
    'SUMMARY:Standup',
    'DESCRIPTION:Join with Google Meet: https://meet.google.com/abc-defg-hij\\nOr dial in',
    'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'TRIGGER:-PT10M',
    'SUMMARY:alarm summary must not leak',
    'END:VALARM',
    'END:VEVENT',
    # moved instance: Fri 23 Oct 09:30 -> 11:00, retitled
    'BEGIN:VEVENT',
    'DTSTART;TZID=Europe/Prague:20261023T110000',
    'DTEND;TZID=Europe/Prague:20261023T111500',
    'RECURRENCE-ID;TZID=Europe/Prague:20261023T093000',
    'UID:standup-1@google.com',
    'SUMMARY:Standup (moved)',
    'END:VEVENT',
    # cancelled instance: Mon 2 Nov
    'BEGIN:VEVENT',
    'DTSTART;TZID=Europe/Prague:20261102T093000',
    'DTEND;TZID=Europe/Prague:20261102T094500',
    'RECURRENCE-ID;TZID=Europe/Prague:20261102T093000',
    'UID:standup-1@google.com',
    'SUMMARY:Standup',
    'STATUS:CANCELLED',
    'END:VEVENT',
])
GOOGLE_HEAD = '\r\n'.join([
    'X-WR-CALNAME:Work', 'X-WR-TIMEZONE:Europe/Prague',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Prague',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
    'END:VTIMEZONE',
])


class GoogleWeekly(unittest.TestCase):
    def setUp(self):
        self.evs = run(feed(GOOGLE_STANDUP, head=GOOGLE_HEAD))

    def test_instances_exceptions_and_dst(self):
        got = [(e['title'], utc(e['start'])) for e in self.evs]
        self.assertEqual(got, [
            ('Standup', '2026-10-19T07:30Z'),          # Mon, CEST (+2)
            # Wed 21 Oct: EXDATE
            ('Standup (moved)', '2026-10-23T09:00Z'),  # Fri, moved to 11:00 CEST
            # Sun 25 Oct: DST ends in Europe/Prague
            ('Standup', '2026-10-26T08:30Z'),          # Mon, CET (+1): same 09:30 wall time
            ('Standup', '2026-10-28T08:30Z'),
            ('Standup', '2026-10-30T08:30Z'),
            # Mon 2 Nov: cancelled override
            ('Standup', '2026-11-04T08:30Z'),
            ('Standup', '2026-11-06T08:30Z'),
        ])

    def test_shape(self):
        e = self.evs[0]
        self.assertEqual(set(e), {'title', 'start', 'end', 'calendar', 'color', 'allDay', 'location', 'url', 'source'})
        self.assertEqual(e['start'], '2026-10-19T09:30:00+02:00')
        self.assertEqual(e['end'], '2026-10-19T09:45:00+02:00')
        self.assertEqual(self.evs[2]['start'], '2026-10-26T09:30:00+01:00')
        self.assertEqual(e['calendar'], 'Work')  # X-WR-CALNAME
        self.assertEqual(e['url'], 'https://meet.google.com/abc-defg-hij')
        self.assertFalse(e['allDay'])
        self.assertEqual(e['source'], 'ics')

    def test_name_and_color_override(self):
        evs = run(feed(GOOGLE_STANDUP, head=GOOGLE_HEAD), name='Job', color='#FF0000')
        self.assertEqual({(e['calendar'], e['color']) for e in evs}, {('Job', '#FF0000')})

    def test_until_stops_series(self):
        evs = run(feed(GOOGLE_STANDUP, head=GOOGLE_HEAD), '2026-12-28T00:00', '2027-01-15T00:00')
        self.assertEqual([utc(e['start']) for e in evs], ['2026-12-28T08:30Z', '2026-12-30T08:30Z'])  # Fri 1 Jan > UNTIL

    def test_window_far_in_future_skips_fast(self):
        text = feed('BEGIN:VEVENT\r\nUID:d\r\nDTSTART:20000103T090000Z\r\nDTEND:20000103T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\nSUMMARY:Old weekly\r\nEND:VEVENT')
        evs = run(text, '2026-10-26T00:00', '2026-11-02T00:00')
        self.assertEqual([utc(e['start']) for e in evs], ['2026-10-26T09:00Z'])


# iCloud style: X-APPLE-CALENDAR-COLOR, VALUE=DATE all-day, folded lines, escaped text.
ICLOUD = feed('\r\n'.join([
    'BEGIN:VEVENT',
    'UID:trip-1',
    'DTSTART;VALUE=DATE:20261030',
    'DTEND;VALUE=DATE:20261102',
    'SUMMARY:Weekend in Vienna\\, Austria',
    'LOCATION:Vienna',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:bday-1',
    'DTSTART;VALUE=DATE:19900105',
    'RRULE:FREQ=YEARLY',
    'SUMMARY:Grandma\'s birthday',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:long-1',
    'DTSTART;TZID=Europe/Prague:20261027T180000',
    'DURATION:PT1H30M',
    'SUMMARY:A very long title that the publisher folds across sev',
    ' eral lines because it is longer than seventy-five octets',
    'END:VEVENT',
]), head='X-WR-CALNAME:Family\r\nX-APPLE-CALENDAR-COLOR:#FF2968FF')


class ICloud(unittest.TestCase):
    def test_all_day_multi_day(self):
        evs = [e for e in run(ICLOUD) if e['title'].startswith('Weekend')]
        self.assertEqual(len(evs), 1)
        e = evs[0]
        self.assertTrue(e['allDay'])
        self.assertEqual((e['start'], e['end']), ('2026-10-30T00:00:00+01:00', '2026-11-02T00:00:00+01:00'))
        self.assertEqual(e['title'], 'Weekend in Vienna, Austria')
        self.assertEqual((e['calendar'], e['color'], e['location']), ('Family', '#FF2968', 'Vienna'))

    def test_all_day_overlapping_window_start(self):
        evs = run(ICLOUD, '2026-11-01T00:00', '2026-11-03T00:00')
        self.assertEqual([e['title'] for e in evs], ['Weekend in Vienna, Austria'])

    def test_yearly_all_day(self):
        evs = run(ICLOUD, '2027-01-01T00:00', '2027-01-10T00:00')
        self.assertEqual([(e['title'], e['start'], e['end']) for e in evs],
                         [("Grandma's birthday", '2027-01-05T00:00:00+01:00', '2027-01-06T00:00:00+01:00')])

    def test_folding_and_duration(self):
        e = next(e for e in run(ICLOUD) if e['title'].startswith('A very'))
        self.assertEqual(e['title'], 'A very long title that the publisher folds across several lines because it is longer than seventy-five octets')
        self.assertEqual((e['start'], e['end']), ('2026-10-27T18:00:00+01:00', '2026-10-27T19:30:00+01:00'))


def ev(*lines, uid='x'):
    return '\r\n'.join(['BEGIN:VEVENT', f'UID:{uid}', *lines, 'END:VEVENT'])


class Rules(unittest.TestCase):
    def starts(self, rrule, dtstart='DTSTART;TZID=Europe/Prague:20260105T100000', a='2026-01-01T00:00', b='2027-01-01T00:00', extra=()):
        text = feed(ev(dtstart, 'DURATION:PT1H', f'RRULE:{rrule}', 'SUMMARY:x', *extra))
        return [datetime.fromisoformat(e['start']).astimezone(PRAGUE).strftime('%Y-%m-%d %H:%M') for e in run(text, a, b)]

    def test_monthly_first_monday(self):
        got = self.starts('FREQ=MONTHLY;BYDAY=1MO;COUNT=4')
        self.assertEqual(got, ['2026-01-05 10:00', '2026-02-02 10:00', '2026-03-02 10:00', '2026-04-06 10:00'])

    def test_monthly_last_friday(self):
        got = self.starts('FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', 'DTSTART;TZID=Europe/Prague:20260130T160000')
        self.assertEqual(got, ['2026-01-30 16:00', '2026-02-27 16:00', '2026-03-27 16:00'])

    def test_monthly_bymonthday_and_negative(self):
        self.assertEqual(self.starts('FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3', 'DTSTART;TZID=Europe/Prague:20260115T080000'),
                         ['2026-01-15 08:00', '2026-02-15 08:00', '2026-03-15 08:00'])
        self.assertEqual(self.starts('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3', 'DTSTART;TZID=Europe/Prague:20260131T080000'),
                         ['2026-01-31 08:00', '2026-02-28 08:00', '2026-03-31 08:00'])

    def test_monthly_on_31st_skips_short_months(self):
        got = self.starts('FREQ=MONTHLY;COUNT=3', 'DTSTART;TZID=Europe/Prague:20260131T080000')
        self.assertEqual(got, ['2026-01-31 08:00', '2026-03-31 08:00', '2026-05-31 08:00'])

    def test_last_weekday_bysetpos(self):
        got = self.starts('FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3', 'DTSTART;TZID=Europe/Prague:20260130T080000')
        self.assertEqual(got, ['2026-01-30 08:00', '2026-02-27 08:00', '2026-03-31 08:00'])

    def test_daily_interval_count(self):
        self.assertEqual(self.starts('FREQ=DAILY;INTERVAL=3;COUNT=4'), ['2026-01-05 10:00', '2026-01-08 10:00', '2026-01-11 10:00', '2026-01-14 10:00'])

    def test_biweekly(self):
        self.assertEqual(self.starts('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=4', 'DTSTART;TZID=Europe/Prague:20260106T100000'),
                         ['2026-01-06 10:00', '2026-01-08 10:00', '2026-01-20 10:00', '2026-01-22 10:00'])

    def test_count_counts_from_dtstart_not_window(self):
        got = self.starts('FREQ=WEEKLY;COUNT=10', a='2026-03-01T00:00', b='2026-04-01T00:00')
        self.assertEqual(got, ['2026-03-02 10:00', '2026-03-09 10:00'])  # 10th and last instance is 9 Mar

    def test_yearly_bymonth_byday(self):
        got = self.starts('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', 'DTSTART;TZID=America/New_York:20201126T120000', '2026-01-01T00:00', '2028-01-01T00:00')
        self.assertEqual(got, ['2026-11-26 18:00', '2027-11-25 18:00'])

    def test_until_date_only(self):
        self.assertEqual(self.starts('FREQ=DAILY;UNTIL=20260107'), ['2026-01-05 10:00', '2026-01-06 10:00', '2026-01-07 10:00'])

    def test_rdate_and_exdate_list(self):
        got = self.starts('FREQ=DAILY;COUNT=4', extra=('EXDATE;TZID=Europe/Prague:20260106T100000,20260107T100000',
                                                       'RDATE;TZID=Europe/Prague:20260120T100000'))
        self.assertEqual(got, ['2026-01-05 10:00', '2026-01-08 10:00', '2026-01-20 10:00'])

    def test_unsupported_rule_shows_first_instance(self):
        self.assertEqual(self.starts('FREQ=HOURLY;COUNT=5'), ['2026-01-05 10:00'])
        self.assertEqual(self.starts('FREQ=DAILY;BYHOUR=9,17;COUNT=5'), ['2026-01-05 10:00'])


class Misc(unittest.TestCase):
    def test_utc_and_floating(self):
        text = feed(ev('DTSTART:20261028T120000Z', 'DTEND:20261028T130000Z', 'SUMMARY:UTC', uid='a'),
                    ev('DTSTART:20261028T150000', 'DTEND:20261028T160000', 'SUMMARY:Floating', uid='b'))
        evs = {e['title']: e for e in run(text)}
        self.assertEqual(evs['UTC']['start'], '2026-10-28T13:00:00+01:00')
        self.assertEqual(evs['Floating']['start'], '2026-10-28T15:00:00+01:00')  # household zone

    def test_windows_tzid(self):
        text = feed(ev('DTSTART;TZID="W. Europe Standard Time":20261028T090000', 'DTEND;TZID="W. Europe Standard Time":20261028T093000',
                       'SUMMARY:Outlook'))
        self.assertEqual(run(text)[0]['start'], '2026-10-28T09:00:00+01:00')

    def test_cancelled_series_and_overrides_hidden(self):
        text = feed(ev('DTSTART:20261026T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=5', 'STATUS:CANCELLED', 'SUMMARY:Gone', uid='c'),
                    ev('RECURRENCE-ID:20261027T090000Z', 'DTSTART:20261027T100000Z', 'DURATION:PT1H', 'SUMMARY:Gone too', uid='c'))
        self.assertEqual(run(text), [])

    def test_override_moved_into_window_from_outside(self):
        text = feed(ev('DTSTART;TZID=Europe/Prague:20261012T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=2', 'SUMMARY:Review', uid='r'),
                    ev('RECURRENCE-ID;TZID=Europe/Prague:20261019T090000', 'DTSTART;TZID=Europe/Prague:20261020T090000', 'DURATION:PT1H',
                       'SUMMARY:Review', uid='r'))
        self.assertEqual([e['start'] for e in run(text)], ['2026-10-20T09:00:00+02:00'])

    def test_garbage_is_skipped(self):
        text = feed(ev('DTSTART:notadate', 'SUMMARY:bad', uid='1'), 'this is not a content line',
                    ev('DTSTART;VALUE=DATE:20261028', 'SUMMARY:ok', uid='2'), 'BEGIN:VEVENT\r\nSUMMARY:no end')
        self.assertEqual([e['title'] for e in run(text)], ['ok'])

    def test_location_url_is_not_a_location(self):
        e = run(feed(ev('DTSTART:20261028T120000Z', 'SUMMARY:Call', 'LOCATION:https://zoom.us/j/123456')))[0]
        self.assertIsNone(e['location'])
        self.assertEqual(e['url'], 'https://zoom.us/j/123456')

    def test_events_outside_window_dropped(self):
        text = feed(ev('DTSTART:20250101T120000Z', 'SUMMARY:old', uid='o'), ev('DTSTART:20261028T120000Z', 'SUMMARY:now', uid='n'))
        self.assertEqual([e['title'] for e in run(text)], ['now'])


class Feeds(unittest.TestCase):
    """Settings parsing and merge rules in dashconfig / server (no network)."""

    def test_parse_feeds(self):
        import dashconfig as C
        got = C.parse_ics_feeds('Work|#1BADF8|https://calendar.google.com/calendar/ical/x/private-abc/basic.ics;\n'
                                'webcal://p01-caldav.icloud.com/published/2/abc\nhttps://example.com/a.ics?x=1;y=2 ; Home||https://h.example/c.ics')
        self.assertEqual(got, [
            {'name': 'Work', 'color': '#1BADF8', 'url': 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics'},
            {'name': '', 'color': '', 'url': 'https://p01-caldav.icloud.com/published/2/abc'},
            {'name': '', 'color': '', 'url': 'https://example.com/a.ics?x=1;y=2'},
            {'name': 'Home', 'color': '', 'url': 'https://h.example/c.ics'},
        ])

    def test_bad_entries_dropped(self):
        import dashconfig as C
        self.assertEqual(C.parse_ics_feeds('Work|red|https://a.example/x.ics\nftp://nope\njust text\n\n'),
                         [{'name': 'Work', 'color': '', 'url': 'https://a.example/x.ics'}])

    def test_url_host(self):
        import dashconfig as C
        self.assertEqual(C.url_host('https://user:pw@calendar.google.com:443/calendar/ical/secret/basic.ics'), 'calendar.google.com')


if __name__ == '__main__':
    unittest.main()
