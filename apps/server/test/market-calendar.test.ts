import { expect, test } from 'vitest';
import {
  readCalendarDays,
  officialCalendarUrl,
} from '../src/market-calendar.js';

const cells = Array.from(
  { length: 28 },
  (_, i) =>
    '<td class="is-' +
    (['holiday', 'extra'][i] ?? 'workday') +
    '">' +
    (i + 1) +
    '</td>',
).join('');
const html =
  '<li class="m-calendar-nav__item is-this">February 2027</li><table class="m-calendar">' +
  cells +
  '</table>';
test('calendar reads official classes, including exceptional opening days', () => {
  expect(readCalendarDays(html, '2027-02').split('\n').slice(0, 3)).toEqual([
    '2027-02-01 정기 휴장',
    '2027-02-02 임시 개장',
    '2027-02-03 개장',
  ]);
});
test('mismatched month, missing date or unfamiliar status fail closed', () => {
  expect(() => readCalendarDays(html, '2028-02')).toThrow();
  expect(() =>
    readCalendarDays(html.replace('>28<', '>27<'), '2027-02'),
  ).toThrow();
  expect(() =>
    readCalendarDays(html.replace('is-holiday', 'unknown'), '2027-02'),
  ).toThrow();
  expect(() => officialCalendarUrl('https://example.com')).toThrow();
});
