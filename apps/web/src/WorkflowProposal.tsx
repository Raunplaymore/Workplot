import { useEffect, useRef, useState } from 'react';
import {
  proposalResponseSchema,
  workflowPlan,
  type WorkflowDefinition,
  type ClarificationTurn,
} from '@studio/contracts';
import styles from './WorkflowStudio.module.css';

export function WorkflowProposal({
  base,
  propose,
  apply,
  close,
}: {
  base: WorkflowDefinition | null;
  propose: (
    request: string,
    signal: AbortSignal,
    turns: ClarificationTurn[],
  ) => Promise<unknown>;
  apply: (definition: WorkflowDefinition) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef<AbortController | null>(null);
  const [request, setRequest] = useState('');
  const [candidate, setCandidate] = useState<WorkflowDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<ClarificationTurn[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const answerField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (question && !busy) answerField.current?.focus();
  }, [question, busy]);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    return () => active.current?.abort();
  }, []);
  async function generate() {
    if (active.current || !request.trim() || (question && !answer.trim()))
      return;
    const context = question
      ? [...turns, { question, answer: answer.trim() }]
      : turns;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setNotice('');
    try {
      const result = proposalResponseSchema.parse(
        await propose(request, controller.signal, context),
      );
      if (controller.signal.aborted) return;
      setTurns(context);
      setAnswer('');
      setQuestion(result.kind === 'question' ? result.text : '');
      if (result.kind === 'proposal') setCandidate(result.definition);
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice(
          error instanceof Error ? error.message : '변경안을 만들 수 없습니다.',
        );
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const original = base ? workflowPlan(base).steps : [];
  const steps = candidate ? workflowPlan(candidate).steps : original;
  const stride = 190,
    width = 160;
  const transfers = steps.flatMap((step, to) =>
    step.kind === 'task'
      ? step.inputs.map((id) => ({
          from: steps.findIndex((s) => s.id === id),
          to,
        }))
      : [],
  );
  const lane = (from: number, to: number) => 108 + 16 * (to - from);
  const height = Math.max(
    120,
    ...transfers.map((edge) => lane(edge.from, edge.to) + 12),
  );
  return (
    <dialog
      ref={dialog}
      className={styles.proposal}
      onCancel={close}
      aria-labelledby="proposal-heading"
    >
      <h2 id="proposal-heading">
        {base
          ? candidate
            ? '변경안 미리보기'
            : '말로 흐름 수정'
          : candidate
            ? candidate.name
            : '목표로 새 흐름 만들기'}
      </h2>
      <label>
        {base ? '변경 요청' : '업무 목표'}
        <textarea
          value={request}
          disabled={busy || !!candidate || !!question}
          maxLength={base ? 2000 : 1000}
          rows={2}
          autoFocus
          placeholder={
            base
              ? '어떤 단계를 추가하고 어떤 문서를 전달할까요?'
              : '어떤 결과를 만들고 언제 직접 확인하고 싶으세요?'
          }
          onChange={(e) => setRequest(e.target.value)}
        />
      </label>
      {turns.map((turn, index) => (
        <div key={index} className={styles.clarification}>
          <strong>{turn.question}</strong>
          <p>{turn.answer}</p>
        </div>
      ))}
      {question && (
        <div className={styles.clarification}>
          <p id="workflow-clarification">
            <strong>{question}</strong>
          </p>
          <label>
            내 답변
            <textarea
              ref={answerField}
              aria-describedby="workflow-clarification"
              rows={2}
              maxLength={1000}
              value={answer}
              disabled={busy}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </label>
        </div>
      )}
      {steps.length > 0 && (
        <>
          <div className={styles.wireKey}>
            <span>실행 순서</span>
            <span>전달 문서</span>
          </div>
          <div className={styles.proposalScroll} aria-label="변경안 와이어">
            <div
              style={{
                width: steps.length * stride - 14,
                height,
                position: 'relative',
              }}
            >
              <svg width="100%" height={height} aria-hidden="true">
                <defs>
                  <marker
                    id="proposal-arrow"
                    markerWidth="7"
                    markerHeight="7"
                    refX="6"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0 0 L6 3 L0 6" fill="none" stroke="#3c5148" />
                  </marker>
                </defs>
                {steps.slice(1).map((s, i) => (
                  <path
                    key={s.id}
                    stroke="#3c5148"
                    strokeWidth="2"
                    markerEnd="url(#proposal-arrow)"
                    d={`M ${8 + i * stride + width} 49 h ${stride - width - 3}`}
                  />
                ))}
                {transfers.map(({ from, to }) => (
                  <path
                    key={from + '-' + to}
                    stroke="#207b82"
                    strokeDasharray="5 4"
                    fill="none"
                    d={`M ${8 + from * stride + width * 0.65} 86 V ${lane(from, to)} H ${8 + to * stride + width * 0.35} V 86`}
                  />
                ))}
              </svg>
              {steps.map((s, i) => {
                const added = !!base && !original.some((o) => o.id === s.id);
                return (
                  <div
                    className={styles.proposedNode}
                    key={s.id}
                    data-added={added}
                    style={{ left: 8 + i * stride, width }}
                  >
                    <small>
                      {added ? '추가 · ' : ''}
                      {s.kind === 'review' ? '사용자 승인' : 'Codex 작업'}
                    </small>
                    <strong>{s.title}</strong>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      {candidate && (
        <ul aria-label="문서 연결 변경">
          {steps
            .filter(
              (s) =>
                s.kind === 'task' &&
                JSON.stringify(s.inputs) !==
                  JSON.stringify(original.find((o) => o.id === s.id)?.inputs),
            )
            .map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong> ←{' '}
                {s.inputs
                  .map((id) => steps.find((o) => o.id === id)?.title)
                  .join(' + ') || '원본 자료'}
              </li>
            ))}
        </ul>
      )}
      <p role="status">
        {notice ||
          (busy
            ? 'Codex가 변경안을 작성하고 있습니다.'
            : candidate
              ? '적용하면 편집기에 반영됩니다. 저장과 업무 실행은 별도입니다.'
              : '')}
      </p>
      <footer>
        {candidate ? (
          <button className={styles.primary} onClick={() => apply(candidate)}>
            {base ? '변경안 적용' : '새 흐름 적용'}
          </button>
        ) : (
          <button
            className={styles.primary}
            disabled={busy || !request.trim() || (!!question && !answer.trim())}
            onClick={() => void generate()}
          >
            {question
              ? '답변 보내기'
              : base
                ? '변경안 만들기'
                : '설계안 만들기'}
          </button>
        )}
        <button onClick={close}>취소</button>
      </footer>
    </dialog>
  );
}
