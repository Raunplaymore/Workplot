import { useEffect, useRef, useState } from 'react';
import { localRequest } from './local-request';
import styles from './EditorChat.module.css';

export type ChatTarget = {
  key: string;
  label: string;
  context: string;
  prompt: string | null;
  stepId?: string;
  file?: string;
  sessions?: { id: string; runNumber: number }[];
};
type Message = { role: 'assistant' | 'user'; text: string };
export function EditorChat({
  target,
  open,
  close,
  apply,
  currentPrompt,
}: {
  target: ChatTarget;
  open: boolean;
  close: () => void;
  currentPrompt: string | null;
  apply: (value: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [request, setRequest] = useState('');
  const [proposal, setProposal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [base, setBase] = useState(target.prompt);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const el = dialog.current!;
    if (open) el.showModal();
    return () => el.close();
  }, [open]);
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, open]);
  async function send() {
    if (!request.trim() || busy) return;
    const ac = new AbortController();
    controller.current = ac;
    setBusy(true);
    setError('');
    const history: Message[] = [
      ...messages,
      { role: 'user', text: request.trim() },
    ];
    try {
      const records = await Promise.all(
        (target.sessions ?? []).map(async (session) => {
          const path =
            '/runs/' +
            session.id +
            '/results/' +
            encodeURIComponent(target.file!);
          const [doc, origin] = await Promise.all([
            localRequest(path, 'GET', undefined, ac.signal).then((r) =>
              r.text(),
            ),
            localRequest(path + '/prompt-origin', 'GET', undefined, ac.signal)
              .then((r) => r.json())
              .catch(() => null),
          ]);
          return {
            session: session.runNumber,
            run: session.id,
            file: target.file,
            document: doc.slice(0, 8000),
            truncated: doc.length > 8000,
            generatingPrompt:
              origin?.instructions?.slice(0, 8000) ?? '생성 지침 미확인',
          };
        }),
      );
      const result = await (
        await localRequest(
          '/editor-chat',
          'POST',
          {
            target: target.label,
            context: JSON.stringify({
              wire: target.context,
              records,
              previousProposal: proposal,
            }),
            prompt: currentPrompt,
            messages: history.slice(-12),
          },
          ac.signal,
        )
      ).json();
      if (ac.signal.aborted) return;
      setBase(currentPrompt);
      setMessages([...history, { role: 'assistant', text: result.answer }]);
      setProposal(result.replacement);
      setRequest('');
    } catch (e) {
      if (!ac.signal.aborted)
        setError(e instanceof Error ? e.message : '요청 실패');
    } finally {
      if (!ac.signal.aborted) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className={styles.panel}
      aria-label="Ask AI"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <h2>Ask AI</h2>
        <button onClick={close}>Close</button>
      </header>
      <small>{target.label}</small>
      <div className={styles.thread} aria-live="polite">
        {messages.map((m, i) => (
          <section key={i}>
            <strong>{m.role === 'user' ? 'You' : 'AI'}</strong>
            <p>{m.text}</p>
          </section>
        ))}
        {proposal && (
          <section>
            <strong>Prompt revision</strong>
            <details>
              <summary>Current prompt</summary>
              <pre>{base}</pre>
            </details>
            <pre>{proposal}</pre>
            <button
              disabled={busy || currentPrompt !== base}
              onClick={() => {
                apply(proposal);
                setMessages((prev) => [
                  ...prev,
                  { role: 'assistant', text: '편집 초안에 반영했습니다.' },
                ]);
                setProposal('');
              }}
            >
              Apply to draft
            </button>
            {currentPrompt !== base && (
              <p>단계가 변경되었습니다. 현재 지침으로 다시 요청하세요.</p>
            )}
          </section>
        )}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <label>
          Message
          <textarea
            autoFocus
            rows={3}
            maxLength={2000}
            value={request}
            disabled={busy}
            onChange={(e) => setRequest(e.target.value)}
            placeholder="평가하거나 수정할 내용을 적어 주세요"
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy || !request.trim()}>
          {busy ? 'Thinking…' : 'Send'}
        </button>
      </form>
    </dialog>
  );
}
