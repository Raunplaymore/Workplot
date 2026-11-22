export type DocumentSource = {
  id: string;
  recordedAt: string;
  runNumber: number;
};

const executionTime = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function documentSourceLabel(source: DocumentSource, latest: boolean) {
  const result = latest ? '최근 결과' : '이전 결과';
  return [
    result,
    source.runNumber + '회차',
    executionTime.format(new Date(source.recordedAt)),
  ].join(' · ');
}
