import { useEffect, useState } from 'react';
import {
  delegationStatusSchema,
  runViewSchema,
  workflowVersionSchema,
  type RunList,
} from '@studio/contracts';
import { localRequest } from './local-request';
import { sessionHeadline } from './SessionTrail';
import styles from './WorkflowStudio.module.css';

function excerpt(markdown: string) {
  const lines = markdown.split('\n').map((line) => line.trim());
  const first =
    lines.find((line) => /^추천 과제\s*[·:]/.test(line)) ??
    lines.find((line) => line && !/^(#|\||```|---)/.test(line));
  const plain = (first ?? '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/^[-+]\s+/, '')
    .trim();
  return plain.length > 160 ? plain.slice(0, 159) + '…' : plain;
}

type Detail = {
  delivery: string;
  stage: string;
  task: string;
  delegation: string;
  documents: { file: string; title: string; text: string }[];
};
export function ActiveSessionCard({
  row,
  history,
  status,
  action,
}: {
  row: RunList[number];
  history: RunList;
  status: string;
  action: string;
}) {
  const [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(false);
  const { id, workflowId, workflowVersion } = row;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const cache = new Map<string, string>();
    let titles: Map<string, string> | undefined;
    const get = (path: string) =>
      localRequest(path, 'GET', undefined, controller.signal);
    async function refresh() {
      try {
        const base = '/runs/' + id;
        const [view, delivery, state] = await Promise.all([
          get(base + '/view')
            .then((r) => r.json())
            .then((v) => runViewSchema.parse(v)),
          get(base + '/delivery').then((r) => r.json()),
          get(base + '/delegation')
            .then((r) => r.json())
            .then((v) => delegationStatusSchema.parse(v)),
        ]);
        if (!titles) {
          const version = workflowVersionSchema.parse(
            await (
              await get(
                '/workflows/' +
                  workflowId +
                  '/versions/' +
                  workflowVersion +
                  '?expanded=1',
              )
            ).json(),
          );
          titles = new Map(
            version.definition.steps.map((s) => [s.id, s.title]),
          );
        }
        const labels = titles;
        const docs = await Promise.all(
          view.results.map(async (file) => {
            let text = cache.get(file);
            if (text === undefined) {
              text = excerpt(
                await (
                  await get(base + '/results/' + encodeURIComponent(file))
                ).text(),
              );
              cache.set(file, text);
            }
            return {
              file,
              text,
              title: labels.get(file.replace(/\.md$/, '')) ?? file,
            };
          }),
        );
        const task =
          docs.find((d) => d.file === 'options.md') ??
          docs.find((d) => d.file === 'session-plan.md');
        const config = state.config;
        const delegation = config
          ? (state.enabled ? '자동승인 켜짐' : '자동승인 종료') +
            ' · ' +
            (config.maxSessions === null
              ? '횟수 제한 없음'
              : state.used + '/' + config.maxSessions + '회') +
            ' · ' +
            new Date(config.until).toLocaleTimeString('ko-KR', {
              hour: '2-digit',
              minute: '2-digit',
            }) +
            '까지'
          : '';
        if (!controller.signal.aborted) {
          setDetail({
            delivery: [
              delivery.receipts.at(-1),
              delivery.integration &&
                '통합 큐 · ' + delivery.integration.status,
              delivery.applied &&
                '대상 브랜치 반영 · ' + delivery.applied.slice(0, 8),
            ]
              .filter(Boolean)
              .join(' / '),
            stage: labels.get(view.stepId ?? '') ?? view.stepId ?? '',
            task: task?.text || view.summary.taskRequest || docs[0]?.text || '',
            documents: docs,
            delegation,
          });
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, workflowId, workflowVersion]);
  const docs = detail?.documents ?? [];
  const latest = docs.at(-1);
  return (
    <article className={styles.activeCard}>
      <header>
        <h4>{row.name}</h4>
        <span>
          v{workflowVersion} · {history.length + 1}회차
        </span>
      </header>
      <strong>
        {status}
        {detail?.stage && ' · ' + detail.stage}
      </strong>
      <a href={'#/runs/' + id}>{action} →</a>
      {detail?.task && <p>{detail.task}</p>}
      {latest && latest.text !== detail?.task && (
        <p>
          <b>{latest.title}</b> · {latest.text || latest.file}
        </p>
      )}
      {error && <p role="status">최신 세션 기록을 다시 불러오는 중입니다.</p>}
      {detail?.delivery && <p>{detail.delivery}</p>}
      {detail?.delegation && <small>{detail.delegation}</small>}
      {docs.length > 0 && (
        <details>
          <summary>이번 회차 수행 기록 {docs.length}건</summary>
          <ol>
            {docs.map((d) => (
              <li key={d.file}>
                <b>{d.title}</b>
                <p>{d.text || d.file}</p>
              </li>
            ))}
          </ol>
        </details>
      )}
      {history.length > 0 && (
        <details>
          <summary>최근 회차 결과</summary>
          <ul>
            {history.slice(0, 3).map((h, i) => (
              <li key={h.id}>
                <a href={'#/runs/' + h.id}>{history.length - i}회차</a> ·{' '}
                {h.sessionSummary
                  ? sessionHeadline(h.sessionSummary, true)
                  : '결과 열기'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}
