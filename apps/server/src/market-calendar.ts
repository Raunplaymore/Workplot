const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export function officialCalendarUrl(month: string) {
  if (!monthPattern.test(month))
    throw Error('월은 YYYY-MM 형식으로 지정하세요.');
  return 'https://www.tsukiji.or.jp/english/calendar/?date=' + month;
}

export function readCalendarDays(html: string, month: string) {
  officialCalendarUrl(month);
  const first = new Date(month + '-01T00:00:00Z');
  const heading = first.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const shown = /class="m-calendar-nav__item is-this">([^<]+)</.exec(html)?.[1];
  const table = /<table class="m-calendar">([\s\S]*?)<\/table>/.exec(html)?.[1];
  if (shown !== heading || !table)
    throw Error('요청한 달력을 확인할 수 없습니다.');
  const days = [
    ...table.matchAll(
      /<td class="is-(workday|holiday|extra)">\s*(\d{1,2})\s*</g,
    ),
  ];
  first.setUTCMonth(first.getUTCMonth() + 1, 0);
  if (
    days.length !== first.getUTCDate() ||
    days.some((d, i) => Number(d[2]) !== i + 1)
  )
    throw Error('달력의 날짜 또는 운영 표시를 확인할 수 없습니다.');
  return days
    .map(
      (d) =>
        month +
        '-' +
        d[2]!.padStart(2, '0') +
        ' ' +
        { workday: '개장', holiday: '정기 휴장', extra: '임시 개장' }[d[1]!],
    )
    .join('\n');
}
