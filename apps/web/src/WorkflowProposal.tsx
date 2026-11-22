import { WorkflowComposer } from './WorkflowComposer';
import { useEffect, useRef, useState } from 'react';
import {
  matchResultSchema,
  type WorkflowMatch,
  type DesignSkill,
  type DesignSkillRef,
  proposalResponseSchema,
  workflowPlan,
  type WorkflowDefinition,
  type ClarificationTurn,
} from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './WorkflowStudio.module.css';

export function WorkflowProposal({
  base,
  guidedSave,
  reuse,
  disabled = false,
  propose,
  apply,
  close,
}: {
  base: WorkflowDefinition | null;
  disabled?: boolean;
  reuse?: (match: WorkflowMatch, signal: AbortSignal) => Promise<void>;
  guidedSave?: (definition: WorkflowDefinition) => Promise<void>;
  propose: (
    request: string,
    signal: AbortSignal,
    turns: ClarificationTurn[],
    skill?: DesignSkillRef,
  ) => Promise<unknown>;
  apply: (definition: WorkflowDefinition) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef<AbortController | null>(null);
  const [previewOpen, setPreviewOpen] = useState(!base);
  const [request, setRequest] = useState('');
  const [match, setMatch] = useState<WorkflowMatch | null>(null);
  const [searching, setSearching] = useState(false);
  const [noMatch, setNoMatch] = useState(false);
  const [skill, setSkill] = useState<DesignSkill | null>(null);
  const [source, setSource] = useState('');
  const saving = useRef(false);
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
    if (previewOpen) dialog.current?.showModal();
  }, [previewOpen]);
  useEffect(() => () => active.current?.abort(), []);
  async function saveCandidate() {
    if (!guidedSave || !candidate || !source.trim() || saving.current) return;
    saving.current = true;
    setBusy(true);
    setNotice('');
    try {
      await guidedSave({ ...candidate, input: source.trim() });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '흐름을 저장하지 못했습니다.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function selectMatch() {
    if (!reuse || !match || active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setNotice('');
    try {
      await reuse(match, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice(
          error instanceof Error
            ? error.message
            : '저장된 흐름을 열 수 없습니다.',
        );
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function generate(instruction = request, designNew = false) {
    if (active.current || !instruction.trim() || (question && !answer.trim()))
      return;
    const context = question
      ? [...turns, { question, answer: answer.trim() }]
      : turns;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setNotice('');
    try {
      if (reuse && !context.length && !designNew) {
        setNoMatch(false);
        setSearching(true);
        const response = await localRequest(
          '/workflow-matches',
          'POST',
          { goal: instruction },
          controller.signal,
        );
        const found = matchResultSchema.parse(await response.json()).match;
        if (controller.signal.aborted) return;
        setSearching(false);
        if (found) {
          setMatch(found);
          return;
        }
        setNoMatch(true);
      }
      const result = proposalResponseSchema.parse(
        await propose(
          instruction,
          controller.signal,
          context,
          skill ? { id: skill.id, digest: skill.digest } : undefined,
        ),
      );
      if (controller.signal.aborted) return;
      setMatch(null);
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
      if (!controller.signal.aborted) {
        setSearching(false);
        setBusy(false);
      }
    }
  }
  if (base && !previewOpen) {
    return (
      <WorkflowComposer
        base={base}
        disabled={disabled}
        value={request}
        change={setRequest}
        skill={skill}
        selectSkill={setSkill}
        submit={(text) => {
          setRequest(text);
          setPreviewOpen(true);
          void generate(text);
        }}
      />
    );
  }
  const original = base ? workflowPlan(base).steps : [];
  const steps = candidate ? workflowPlan(candidate).steps : original;
  const changes: { title: string; text: string }[] = [];
  if (base && candidate) {
    if (candidate.goal && base.goal !== candidate.goal)
      changes.push({ title: '업무 목표', text: candidate.goal });
    if (candidate.doneWhen && base.doneWhen !== candidate.doneWhen)
      changes.push({ title: '완료 기준', text: candidate.doneWhen });
    for (const s of candidate.steps) {
      const old = base.steps.find((o) => o.id === s.id);
      if (
        s.kind === 'task' &&
        s.codexSkill &&
        (old?.kind !== 'task' ||
          old.codexSkill?.id !== s.codexSkill.id ||
          old.codexSkill?.digest !== s.codexSkill.digest)
      )
        changes.push({
          title: s.title + ' · 실행 스킬',
          text: '$' + s.codexSkill.title,
        });
      if (
        s.kind === 'task' &&
        (old?.kind !== 'task' || s.instructions !== old.instructions)
      )
        changes.push({ title: s.title + ' · 작업 지침', text: s.instructions });
    }
  }
  const width = 140;
  const nodeHeight = 58;
  const top = 12;
  const bottom = top + nodeHeight;
  const gap = 30;
  const stride = width + gap;
  const transfers = steps.flatMap((step, to) =>
    step.kind === 'task'
      ? step.inputs.map((id) => ({
          from: steps.findIndex((s) => s.id === id),
          to,
        }))
      : [],
  );
  const lane = (from: number, to: number) => bottom + 22 + 16 * (to - from);
  const height = Math.max(
    bottom + 12,
    ...transfers.map((edge) => lane(edge.from, edge.to) + 12),
  );
  return (
    <dialog
      ref={dialog}
      className={styles.proposal}
      onCancel={(event) => {
        if (saving.current) event.preventDefault();
        else close();
      }}
      aria-labelledby="proposal-heading"
    >
      <h2 id="proposal-heading">
        {base
          ? candidate
            ? '변경안 미리보기'
            : '말로 흐름 수정'
          : candidate
            ? candidate.name
            : guidedSave
              ? '목표로 시작'
              : '목표로 새 흐름 만들기'}
      </h2>
      {skill && <small>선택한 스킬 · {skill.title}</small>}
      {guidedSave && !candidate && (
        <p>
          원하는 문서를 한 문장으로 적으세요. 내 워크플로에서 맞는 흐름을 먼저
          찾고, 없으면 새 흐름을 설계합니다.
        </p>
      )}
      <label>
        {base ? '변경 요청' : '업무 목표'}
        <textarea
          value={request}
          disabled={busy || !!candidate || !!question || !!match}
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
      {noMatch && <p>목표에 맞는 저장 흐름이 없어 새 흐름을 설계합니다.</p>}
      {match && (
        <section aria-label="추천 흐름" className={styles.clarification}>
          <small>내 워크플로 · v{match.version}</small>
          <h3>{match.name}</h3>
          <p>{match.reason}</p>
        </section>
      )}
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
                width: steps.length * stride - gap + 16,
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
                    d={`M ${8 + i * stride + width} ${top + nodeHeight / 2} h ${gap - 3}`}
                  />
                ))}
                {transfers.map(({ from, to }) => (
                  <path
                    key={from + '-' + to}
                    stroke="#207b82"
                    strokeDasharray="5 4"
                    fill="none"
                    d={`M ${8 + from * stride + width * 0.65} ${bottom} V ${lane(from, to)} H ${8 + to * stride + width * 0.35} V ${bottom}`}
                  />
                ))}
              </svg>
              {steps.map((s, i) => {
                const task = (candidate ?? base)?.steps.find(
                  (step) => step.id === s.id,
                );
                const bound =
                  task?.kind === 'task' ? task.codexSkill : undefined;
                const added = !!base && !original.some((o) => o.id === s.id);
                return (
                  <div
                    className={styles.proposedNode}
                    key={s.id}
                    data-added={added}
                    style={{
                      top,
                      left: 8 + i * stride,
                      width,
                      height: nodeHeight,
                    }}
                  >
                    <small>
                      {added ? '추가 · ' : ''}
                      {s.kind === 'review' ? '사용자 승인' : 'Codex 작업'}
                    </small>
                    <strong>{s.title}</strong>
                    {bound && (
                      <small title={bound.title} className={styles.boundSkill}>
                        ${bound.title}
                      </small>
                    )}
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
      {changes.map(({ title, text }, i) => (
        <div key={i} className={styles.changedInstruction}>
          <strong>{title}</strong>
          <p>{text}</p>
        </div>
      ))}
      {guidedSave && candidate && (
        <fieldset>
          <legend>문서에 사용할 원본 자료</legend>
          <label>
            원본 자료
            <textarea
              value={source}
              disabled={busy}
              onChange={(e) => setSource(e.target.value)}
              maxLength={8000}
              rows={3}
              placeholder="매장 이름, 주소, 영업시간 등 실제 정보를 입력하세요."
            />
          </label>
          <button
            type="button"
            disabled={busy || !!source.trim()}
            onClick={() =>
              setSource(
                '가상 매장 모퉁이서점. 주소는 느티로 12, 영업시간은 10:00–18:00, 취급 품목은 독립출판물입니다.',
              )
            }
          >
            가상 매장 자료로 연습
          </button>
        </fieldset>
      )}
      <p role="status">
        {notice ||
          (busy
            ? saving.current
              ? '흐름을 저장하고 있습니다.'
              : searching
                ? '내 워크플로에서 맞는 흐름을 찾고 있습니다.'
                : '요청을 처리하고 있습니다.'
            : candidate
              ? guidedSave
                ? '저장한 뒤 편집기에서 실행할 수 있습니다.'
                : '적용하면 편집기에 반영됩니다. 저장과 업무 실행은 별도입니다.'
              : '')}
      </p>
      <footer>
        {match ? (
          <>
            <button
              className={styles.primary}
              disabled={busy}
              onClick={() => void selectMatch()}
            >
              이 흐름 사용
            </button>
            <button
              disabled={busy}
              onClick={() => void generate(request, true)}
            >
              새 흐름 설계
            </button>
          </>
        ) : candidate ? (
          <button
            className={styles.primary}
            disabled={busy || (!!guidedSave && !source.trim())}
            onClick={() =>
              guidedSave ? void saveCandidate() : apply(candidate)
            }
          >
            {guidedSave ? '흐름 저장' : base ? '변경안 적용' : '새 흐름 적용'}
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
                : reuse
                  ? '흐름 찾기'
                  : '설계안 만들기'}
          </button>
        )}
        <button disabled={saving.current} onClick={close}>
          취소
        </button>
      </footer>
    </dialog>
  );
}
