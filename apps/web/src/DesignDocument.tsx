import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import styles from './DesignDocument.module.css';
import { localRequest } from './local-request';
import { DocumentChanges } from './DocumentChanges';
import { MarkdownDocument } from './MarkdownDocument';

import { documentSourceLabel, type DocumentSource } from './document-source';
export function DesignDocument({
  close,
  ask,
  children,
  busy,
  run,
  onRun,
  compare,
  workflowId,
  version,
  file,
}: {
  close: () => void;
  ask: (sessions: DocumentSource[]) => void;
  children?: ReactNode;
  busy: boolean;
  run?: string;
  onRun: (id: string, compare?: boolean) => void;
  compare: boolean;
  workflowId: string;
  version: number;
  file: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  const [runs, setRuns] = useState<DocumentSource[] | null>(null);
  const id = run ?? runs?.[0]?.id;
  const index = runs?.findIndex((item) => item.id === id) ?? -1;
  const current = runs?.[index];
  const previous = index >= 0 ? runs?.[index + 1] : undefined;
  useEffect(() => {
    if (run === undefined && id) onRun(id);
  }, [run, id, onRun]);
  const [error, setError] = useState('');
  useEffect(() => {
    const ac = new AbortController();
    setError('');
    setRuns(null);
    void localRequest(
      '/workflows/' +
        workflowId +
        '/versions/' +
        version +
        '/documents/' +
        encodeURIComponent(file),
      'GET',
      undefined,
      ac.signal,
    )
      .then((r) => r.json())
      .then((items: DocumentSource[]) => {
        if (!ac.signal.aborted) {
          setRuns(items);
        }
      })
      .catch(() => {
        if (!ac.signal.aborted) setError('실행 기록을 불러오지 못했습니다.');
      });
    return () => ac.abort();
  }, [workflowId, version, file]);
  return createPortal(
    <dialog
      className={styles.dialog}
      ref={dialog}
      aria-label={file}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <header>
        <h2>{file}</h2>
        <button
          type="button"
          disabled={!current}
          onClick={() =>
            current &&
            ask(compare && previous ? [current, previous] : [current])
          }
        >
          Ask AI
        </button>
        <button type="button" disabled={busy} onClick={close}>
          Close
        </button>
      </header>
      <div className={styles.panes}>
        <section className={styles.reader}>
          {error ? (
            <p role="alert">{error}</p>
          ) : !runs ? (
            <p>실행 기록 조회 중…</p>
          ) : run !== undefined && !runs.some((item) => item.id === run) ? (
            <p role="alert">
              이 실행 회차의 결과 문서를 찾을 수 없습니다.{' '}
              {runs[0] && (
                <button onClick={() => onRun(runs[0]!.id)}>
                  Open latest result
                </button>
              )}
            </p>
          ) : runs.length === 0 ? (
            <p>저장본 v{version}에 보관된 이 단계의 결과 문서가 없습니다.</p>
          ) : (
            <>
              <label>
                문서를 생성한 실행 · v{version}
                <select value={id} onChange={(e) => onRun(e.target.value)}>
                  {runs.map((r, index) => (
                    <option key={r.id} value={r.id}>
                      {documentSourceLabel(r, index === 0)}
                    </option>
                  ))}
                </select>
              </label>
              {previous || compare ? (
                <button
                  type="button"
                  aria-pressed={compare}
                  onClick={() => id && onRun(id, !compare)}
                >
                  {compare ? 'View document' : 'Compare with previous session'}
                </button>
              ) : (
                <small>이 버전에서 비교할 이전 결과가 없습니다.</small>
              )}
              {id && current && (
                <div
                  className={styles.body}
                  tabIndex={0}
                  aria-label="선택한 실행의 결과"
                >
                  {compare && !previous ? (
                    <p>이 버전에서 비교할 이전 결과가 없습니다.</p>
                  ) : (
                    <Body
                      key={[id, compare && previous?.id].join('/')}
                      current={current}
                      previous={compare ? previous : undefined}
                      file={file}
                    />
                  )}
                </div>
              )}
            </>
          )}
        </section>
        {children && <aside className={styles.instructions}>{children}</aside>}
      </div>
    </dialog>,
    document.body,
  );
}
function Body({
  current,
  previous,
  file,
}: {
  current: DocumentSource;
  previous?: DocumentSource;
  file: string;
}) {
  const id = current.id;
  const priorId = previous?.id;
  const [texts, setTexts] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const ac = new AbortController();
    const read = (runId: string) =>
      localRequest(
        '/runs/' + runId + '/results/' + encodeURIComponent(file),
        'GET',
        undefined,
        ac.signal,
      ).then((r) => r.text());
    void Promise.all(priorId ? [read(id), read(priorId)] : [read(id)])
      .then((documents) => {
        if (!ac.signal.aborted) setTexts(documents);
      })
      .catch(() => {
        if (!ac.signal.aborted) setError('결과 문서를 읽을 수 없습니다.');
      });
    return () => ac.abort();
  }, [id, priorId, file]);
  return error ? (
    <p role="alert">{error}</p>
  ) : texts === null ? (
    <p>문서를 여는 중…</p>
  ) : previous ? (
    <DocumentChanges
      before={texts[1]!}
      after={texts[0]!}
      previous={previous}
      current={current}
    />
  ) : (
    <MarkdownDocument text={texts[0]!} />
  );
}
