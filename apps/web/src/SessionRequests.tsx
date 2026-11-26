import { useEffect, useRef, useState } from 'react';
import { CornerDownRight, MessageSquarePlus } from 'lucide-react';
import { sessionRequestView, type RunView } from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './SessionRequests.module.css';

export function SessionRequests({ summary }: { summary: RunView['summary'] }) {
  const { id, status, nextSessionId } = summary;
  const path = '/runs/' + id + '/session-requests';
  const [view, setView] =
    useState<ReturnType<typeof sessionRequestView.parse>>();
  const [text, setText] = useState(() => sessionStorage.getItem(path) ?? '');
  useEffect(() => {
    if (text) sessionStorage.setItem(path, text);
    else sessionStorage.removeItem(path);
  }, [path, text]);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<{
    round: number;
    runId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(sessionStorage.getItem(path + '.request-id') ?? '');
  const revision = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const initial = revision.current;
    localRequest(path, 'GET', undefined, controller.signal)
      .then((r) => r.json())
      .then((data) => {
        if (!controller.signal.aborted && initial === revision.current)
          setView(sessionRequestView.parse(data));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [path, status, nextSessionId]);
  const active = ['queued', 'running', 'waiting'].includes(status);
  async function submit() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    requestId.current ||= crypto.randomUUID();
    sessionStorage.setItem(path + '.request-id', requestId.current);
    try {
      const response = await localRequest(path, 'POST', {
        id: requestId.current,
        text: text.trim(),
      });
      const saved = sessionRequestView.parse(await response.json());
      revision.current++;
      if (saved.runId === id) setView(saved);
      setReceipt(saved);
      setText('');
      requestId.current = '';
      sessionStorage.removeItem(path + '.request-id');
    } catch (e) {
      setError(
        e instanceof TypeError
          ? '요청 접수를 확인하지 못했습니다. 연결을 확인한 뒤 Submit request로 다시 시도하세요.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  if (
    !active &&
    !view?.incoming.length &&
    !view?.outgoing.length &&
    !receipt &&
    !text
  )
    return null;
  return (
    <section className={styles.card} aria-label="다음 회차 요청">
      <header className={styles.header}>
        <MessageSquarePlus size={18} aria-hidden="true" />
        <h3>다음 회차 요청</h3>
      </header>
      {!!view?.incoming.length && (
        <details className={styles.history}>
          <summary>Requests for this session ({view.incoming.length})</summary>
          <ul>
            {view.incoming.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </details>
      )}
      {!!view?.outgoing.length && (
        <div className={styles.notes}>
          <strong>
            {nextSessionId ? (
              <a href={'#/runs/' + nextSessionId}>
                {view.round + 1}회차에 전달
              </a>
            ) : active ? (
              view.round + 1 + '회차 전달 예정'
            ) : (
              '후속 회차 미시작'
            )}
          </strong>
          <ul>
            {view.outgoing.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </div>
      )}
      {(active || !!text) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="next-round-request">
            {view
              ? view.round + 1 + '회차 계획에 참고할 내용'
              : '다음 회차 계획에 참고할 내용'}
          </label>
          <textarea
            id="next-round-request"
            rows={3}
            maxLength={2000}
            value={text}
            disabled={busy}
            placeholder="다음에 살펴볼 문제나 우선순위를 적어 주세요."
            onChange={(e) => {
              setText(e.target.value);
              requestId.current = '';
              sessionStorage.removeItem(path + '.request-id');
              setReceipt(null);
            }}
          />
          <div className={styles.actions}>
            <small>{text.length.toLocaleString()} / 2,000자</small>
            <button disabled={busy || !text.trim()}>
              <CornerDownRight size={15} aria-hidden="true" />
              {busy ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      )}
      {receipt && (
        <p role="status">
          {receipt.round + 1}회차 계획에 참고하도록 저장했습니다.{' '}
          {receipt.runId !== id && (
            <a href={'#/runs/' + receipt.runId}>진행 중인 회차 열기</a>
          )}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
