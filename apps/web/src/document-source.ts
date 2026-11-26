export type DocumentSource = {
  id: string;
  recordedAt: string;
  runNumber: number;
};

const executionTime = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function documentSourceLabel(source: DocumentSource, latest: boolean) {
  const result = latest ? 'Latest result' : 'Previous result';
  return [
    result,
    'Session ' + source.runNumber,
    executionTime.format(new Date(source.recordedAt)),
  ].join(' · ');
}
