import type { RunList } from '@studio/contracts';
import styles from './WorkflowStudio.module.css';

type Row = RunList[number];
const stamp = new Intl.DateTimeFormat('ko-KR', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const noChange = /^변경 없음(?:[.\s·]|$)/;
function shortSentence(text: string) {
  const clean = text.replace(/\s+/g, ' ').replace(/[`*]/g, '').trim();
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const sentence = sentences[0] ?? '';
  if (sentence.length <= 72) return sentence;
  const words = sentence
    .slice(0, 72)
    .replace(/\s+\S*$/, '')
    .trimEnd();
  return (words || sentence.slice(0, 72)) + '…';
}
export function sessionHeadline(summary: string, includeReason = false) {
  const content =
    summary.split(
      /\s+·\s+(?:실제 검사:|다음 세션 시작|세션 완료|중단|실패)(?:\s|$)/,
    )[0] ?? summary;
  if (noChange.test(content)) {
    const reason = shortSentence(content.replace(noChange, ''));
    return includeReason && reason ? reason : '변경 없음';
  }
  return shortSentence(content) || '세션 기록';
}
function unchanged(row: Row) {
  return row.status === 'completed' && noChange.test(row.sessionSummary ?? '');
}
export function SessionTrail({
  rows,
  labels,
}: {
  rows: RunList;
  labels: Record<Row['status'], string>;
}) {
  if (!rows.length) return null;
  const groups: Row[][] = [];
  for (const row of rows) {
    const prior = groups.at(-1);
    if (
      prior &&
      unchanged(row) &&
      unchanged(prior[0]!) &&
      prior[0]!.workflowVersion === row.workflowVersion
    )
      prior.push(row);
    else groups.push([row]);
  }
  function link(row: Row, withinGroup = false) {
    return (
      <a className={styles.historyLink} href={'#/runs/' + row.id}>
        <time dateTime={row.recordedAt}>
          {stamp.format(new Date(row.recordedAt))}
        </time>
        <span>
          {row.sessionSummary
            ? sessionHeadline(row.sessionSummary, withinGroup)
            : labels[row.status]}
        </span>
        {row.sessionSummary && row.status !== 'completed' && (
          <small>{labels[row.status]}</small>
        )}
      </a>
    );
  }
  return (
    <details className={styles.historyPanel}>
      <summary>
        이전 세션 보기 <span>{rows.length}개</span>
      </summary>
      <ul>
        {groups.map((group) => {
          const row = group[0]!;
          return (
            <li key={row.id}>
              {group.length === 1 ? (
                link(row)
              ) : (
                <details>
                  <summary>
                    <strong>변경 없음</strong> · 연속 {group.length}개 세션
                  </summary>
                  <ul>
                    {group.map((item) => (
                      <li key={item.id}>{link(item, true)}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
