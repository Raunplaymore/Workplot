import { useEffect, useState } from 'react';
import {
  applyParts,
  comparisonSchema,
  facts,
  factLabels,
  type Comparison,
} from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './DocumentComparison.module.css';

const labels = {
  known: '근거 있음',
  missing: '원본에 없음',
  conflict: '원본끼리 충돌',
  uncertain: '확인 필요',
  omitted: '문서에 없음',
  match: '일치',
  mismatch: '불일치',
};
const comparisonHistoryKey = 'studio.document-comparison.history';

type ComparisonDocument = Pick<
  Comparison['original'],
  'runId' | 'version' | 'filename'
>;
type ComparisonVisit = {
  href: string;
  original: ComparisonDocument;
  revision: ComparisonDocument;
};

function documentIdentity({ runId, version, filename }: ComparisonDocument) {
  return `실행 ${runId} · v${version} · ${filename}`;
}

function isComparisonDocument(value: unknown): value is ComparisonDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runId' in value &&
    typeof value.runId === 'string' &&
    'version' in value &&
    typeof value.version === 'number' &&
    'filename' in value &&
    typeof value.filename === 'string'
  );
}

function readComparisonHistory(): ComparisonVisit[] {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(comparisonHistoryKey) ?? '[]',
    );
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (visit): visit is ComparisonVisit =>
        visit !== null &&
        typeof visit === 'object' &&
        typeof visit.href === 'string' &&
        isComparisonDocument(visit.original) &&
        isComparisonDocument(visit.revision) &&
        visit.href === '#/runs/' + visit.revision.runId + '/compare' &&
        /^[0-9a-f-]{36}$/i.test(visit.revision.runId),
    );
  } catch {
    return [];
  }
}

export function DocumentComparison({ runId }: { runId: string }) {
  const path = '/runs/' + runId + '/comparison';
  const href = '#/runs/' + runId + '/compare';
  const [history, setHistory] = useState(readComparisonHistory);
  const previousVisits = history.filter((visit) => visit.href !== href);

  const [data, setData] = useState<Comparison | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const original = data?.original;
  const revision = data?.revision;
  useEffect(() => {
    if (!original || !revision) return;
    const visit: ComparisonVisit = {
      href,
      original: {
        runId: original.runId,
        version: original.version,
        filename: original.filename,
      },
      revision: {
        runId: revision.runId,
        version: revision.version,
        filename: revision.filename,
      },
    };
    const next = [
      visit,
      ...readComparisonHistory().filter((item) => item.href !== href),
    ].slice(0, 20);
    setHistory(next);
    try {
      localStorage.setItem(comparisonHistoryKey, JSON.stringify(next));
    } catch {
      // Keep the history available for this view when browser storage is unavailable.
    }
  }, [href, original, revision]);
  useEffect(() => {
    const cancel = new AbortController();
    void localRequest(path, 'GET', undefined, cancel.signal)
      .then((r) => r.json())
      .then((raw) => {
        if (cancel.signal.aborted) return;
        const c = comparisonSchema.parse(raw);
        setData(c);
        setSelected(c.selected);
      })
      .catch((e) => {
        if (!cancel.signal.aborted) setError(String(e.message));
      });
    return () => cancel.abort();
  }, [path]);
  async function submit(action: 'review' | 'apply') {
    if (!data || busy) return;
    setBusy(true);
    setError('');
    try {
      const body =
        action === 'apply'
          ? { selected, version: data.version, fingerprint: data.fingerprint }
          : undefined;
      const c = comparisonSchema.parse(
        await (await localRequest(path + '/' + action, 'POST', body)).json(),
      );
      setData(c);
      setSelected(c.selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 완료하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }
  const review = data?.review;
  const preview = review ? applyParts(review.parts, selected) : '';
  const dirty =
    !!data &&
    (data.applied === null ||
      data.selected.length !== selected.length ||
      selected.some((i) => !data.selected.includes(i)));
  return (
    <section className={styles.page} aria-label="원안과 수정안 비교">
      <a href={'#/runs/' + runId}>← 실행 상세</a>
      {previousVisits.length > 0 && (
        <nav aria-label="최근 문서 비교">
          <h2>최근 문서 비교</h2>
          <ul>
            {previousVisits.map((visit) => (
              <li key={visit.href}>
                <a href={visit.href}>
                  원안 {documentIdentity(visit.original)}
                  <br />
                  수정안 {documentIdentity(visit.revision)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">문서를 불러오는 중…</p>}
      {data && (
        <>
          <div className={styles.columns}>
            {(['original', 'revision'] as const).map((key, i) => (
              <article key={key}>
                <header>
                  <h2>{i ? '수정안' : '원안'}</h2>
                  <small>{documentIdentity(data[key])}</small>
                </header>
                <pre>{data[key].text}</pre>
                <a href={'#/runs/' + data[key].runId}>
                  Run details · Codex {data[key].cliVersion}
                </a>
              </article>
            ))}
          </div>
          <section className={styles.source}>
            <h2>원본 자료</h2>
            <pre>{data.source || '입력한 자료가 없습니다.'}</pre>
          </section>
          <section className={styles.audit}>
            <h2>주소와 영업시간 대조</h2>
            {!review && (
              <button disabled={busy} onClick={() => void submit('review')}>
                {busy ? 'Checking evidence…' : 'Check evidence with Codex'}
              </button>
            )}
            {review && (
              <>
                <table>
                  <thead>
                    <tr>
                      <th>항목</th>
                      <th>원본 근거</th>
                      <th>원안</th>
                      <th>수정안</th>
                    </tr>
                  </thead>
                  <tbody>
                    {facts.map((key) => {
                      const f = review.facts[key];
                      return (
                        <tr key={key}>
                          <th scope="row">{factLabels[key]}</th>
                          <td>
                            <strong data-verdict={f.status}>
                              {labels[f.status]}
                            </strong>
                            {f.evidence.map((q, i) => (
                              <q key={i}>{q}</q>
                            ))}
                          </td>
                          {[f.original, f.revision].map((d, i) => (
                            <td key={i}>
                              <strong data-verdict={d.verdict}>
                                {labels[d.verdict]}
                              </strong>
                              {d.quote && <q>{d.quote}</q>}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <small>
                  검토 도구 Codex {review.cliVersion} · CLI 기본 모델 사용, 실제
                  모델명 미확인
                </small>
              </>
            )}
          </section>
          {review && (
            <section className={styles.selection}>
              <h2>반영할 변경</h2>
              {!review.parts.some((p) => p.before !== p.after) && (
                <p>두 문서의 내용이 같습니다.</p>
              )}
              {review.parts.map(
                (p, i) =>
                  p.before !== p.after && (
                    <label key={i}>
                      <input
                        type="checkbox"
                        checked={selected.includes(i)}
                        disabled={busy}
                        onChange={(e) => {
                          setSelected((ids) =>
                            e.target.checked
                              ? [...ids, i]
                              : ids.filter((id) => id !== i),
                          );
                        }}
                      />
                      <span>
                        <strong>{p.label}</strong>
                        <del>{p.before || 'Add'}</del>
                        <ins>{p.after || '삭제'}</ins>
                      </span>
                    </label>
                  ),
              )}
              <h3>선택 결과 미리보기</h3>
              <pre aria-label="선택 결과 미리보기">{preview}</pre>
              <button
                disabled={
                  busy || !dirty || (!selected.length && data.applied === null)
                }
                onClick={() => void submit('apply')}
              >
                Apply selected changes
              </button>
              {data.applied !== null && (
                <section className={styles.saved}>
                  <h3>저장한 반영본</h3>
                  <pre>{data.applied}</pre>
                  <a
                    download="반영본.md"
                    href={
                      'data:text/markdown;charset=utf-8,' +
                      encodeURIComponent(data.applied)
                    }
                  >
                    반영본 다운로드
                  </a>
                </section>
              )}
            </section>
          )}
        </>
      )}
    </section>
  );
}
