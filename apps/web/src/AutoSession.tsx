import { useEffect, useRef, useState } from 'react';
import {
  MAX_ADDITIONAL_SESSIONS,
  completionGoalSchema,
  delegationStatusSchema,
  type CompletionGoal,
  type DelegationStatus,
} from '@studio/contracts';
import { localRequest } from './local-request';
function morning() {
  const d = new Date();
  d.setHours(7, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function AutoSession({
  id,
  canConfigure,
  canRetry = false,
  canRestart = false,
  handoffOnly = false,
  openEvidence,
}: {
  id: string;
  canConfigure: boolean;
  handoffOnly?: boolean;
  canRetry?: boolean;
  canRestart?: boolean;
  openEvidence?: (file: string, quote: string) => void;
}) {
  const path = '/runs/' + id + '/delegation';
  const [state, setState] = useState<DelegationStatus | null>(null),
    [editing, edit] = useState(false),
    [draft, setDraft] = useState<CompletionGoal | null>(null),
    [lines, setLines] = useState(''),
    [mission, setMission] = useState(''),
    [unlimited, setUnlimited] = useState(false),
    [max, setMax] = useState(handoffOnly ? 1 : 3),
    [until, setUntil] = useState(morning),
    [busy, setBusy] = useState(false),
    [error, say] = useState('');
  const generation = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    let t: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const v = delegationStatusSchema.parse(
          await (await localRequest(path, 'GET', undefined, c.signal)).json(),
        );
        if (!c.signal.aborted) setState(v);
      } catch (e) {
        if (!c.signal.aborted) say((e as Error).message);
      } finally {
        if (!c.signal.aborted && canConfigure) t = setTimeout(read, 2500);
      }
    }
    void read();
    return () => {
      c.abort();
      clearTimeout(t);
      generation.current?.abort();
    };
  }, [path, canConfigure]);
  async function propose() {
    generation.current?.abort();
    const c = new AbortController();
    generation.current = c;
    setBusy(true);
    say('');
    edit(true);
    try {
      const suggestion = await (
        await localRequest(
          path + '/goal',
          'POST',
          {
            includeMission: true,
            ...(draft && { editedGoal: draft.goal.trim() }),
          },
          c.signal,
        )
      ).json();
      const g = completionGoalSchema.parse(suggestion.goal);
      if (!c.signal.aborted) {
        setMission(suggestion.originalMission);
        setDraft((previous) => ({
          ...g,
          target: previous?.target ?? g.target,
        }));
        setLines(g.criteria.join('\n'));
      }
    } catch (e) {
      if (!c.signal.aborted) {
        say((e as Error).message);
        setDraft(
          (previous) => previous ?? { goal: '', criteria: [], target: 100 },
        );
      }
    } finally {
      if (!c.signal.aborted) {
        generation.current = null;
        setBusy(false);
      }
    }
  }
  async function save(on: boolean) {
    setBusy(true);
    say('');
    try {
      const payload =
        on && handoffOnly
          ? {
              handoffOnly: true,
              goal: '마지막 인계로 다음 회차 시작',
              criteria: ['인계 문서 확인'],
              target: 100,
              maxSessions: unlimited ? null : max,
              until: new Date(until).toISOString(),
            }
          : on
            ? {
                ...draft,
                criteria: lines
                  .split('\n')
                  .map((s) => s.trim())
                  .filter(Boolean),
                maxSessions: unlimited ? null : max,
                until: new Date(until).toISOString(),
              }
            : null;
      if (on && canRestart) {
        const child = await (
          await localRequest(path + '/restart', 'POST', payload)
        ).json();
        location.hash = '/runs/' + child.id;
        return;
      }
      const v = delegationStatusSchema.parse(
        await (
          await localRequest(
            path,
            on ? 'PUT' : 'DELETE',
            on ? payload : undefined,
          )
        ).json(),
      );
      setState(v);
      edit(false);
      setDraft(null);
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sessionLimit = (
    <>
      <label>
        <input
          type="checkbox"
          checked={unlimited}
          onChange={(e) => setUnlimited(e.target.checked)}
        />
        횟수 제한 없음
      </label>
      {!unlimited && (
        <label>
          최대 추가 회차 (1~{MAX_ADDITIONAL_SESSIONS}개)
          <input
            type="number"
            min={1}
            max={MAX_ADDITIONAL_SESSIONS}
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
          />
        </label>
      )}
    </>
  );
  const invalidLimit =
    !unlimited &&
    (!Number.isInteger(max) || max < 1 || max > MAX_ADDITIONAL_SESSIONS);
  if (!canConfigure && !canRestart && !state?.config) return null;
  return (
    <section aria-label="다음 세션 자동승인" style={{ marginBlock: '12px' }}>
      {state?.config && (
        <>
          <strong>
            {state.enabled
              ? '자동승인 켜짐'
              : state.note.startsWith('커밋 복구 대기')
                ? '자동승인 복구 대기'
                : '자동승인 종료'}
          </strong>
          <p>
            {state.config.goal} ·{' '}
            {!state.config.handoffOnly &&
              `달성률 ${state.score ?? '미평가'} / 목표 ${state.config.target}% · `}
            추가 세션{' '}
            {state.config.maxSessions === null
              ? state.used + '회 · 횟수 제한 없음'
              : state.used + '/' + state.config.maxSessions}{' '}
            · {new Date(state.config.until).toLocaleString('ko-KR')}까지
          </p>
          <p>{state.note}</p>
          {state.checks.length > 0 && (
            <details>
              <summary>Criteria results</summary>
              <ul>
                {state.checks.map((c) => {
                  const quote = c.quote;
                  const file = state.evidenceFiles?.[quote];
                  return (
                    <li key={c.criterion}>
                      {c.criterion} ·{' '}
                      {
                        { met: '충족', unmet: '미달', unknown: '미검증' }[
                          c.status
                        ]
                      }{' '}
                      {quote}
                      {c.status !== 'unknown' && file && openEvidence && (
                        <>
                          {' '}
                          <button
                            type="button"
                            onClick={() => openEvidence(file, quote)}
                          >
                            View evidence
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </>
      )}
      {!editing &&
        state?.config &&
        !state.enabled &&
        ((canConfigure &&
          (state.note.startsWith('평가 또는 인계') ||
            state.note === '사용자의 직접 검토 또는 답변이 필요합니다.')) ||
          (canRetry &&
            (state.note === '실행이 끝나 위임을 마쳤습니다.' ||
              state.note.startsWith('단계 응답 시간') ||
              state.note.startsWith('커밋 복구 대기') ||
              state.note.startsWith('평가 또는 인계')))) &&
        Date.parse(state.config.until) > Date.now() && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setState(
                  delegationStatusSchema.parse(
                    await (
                      await localRequest(path + '/resume', 'POST', {})
                    ).json(),
                  ),
                );
                say('');
              } catch (e) {
                say((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Resume auto-approval
          </button>
        )}
      {state?.enabled ? (
        <button disabled={busy} onClick={() => void save(false)}>
          Disable auto-approval
        </button>
      ) : (
        (canConfigure || canRestart) &&
        !editing && (
          <button onClick={() => (handoffOnly ? edit(true) : void propose())}>
            {canRestart ? 'Start from last handoff' : 'Set up auto-approval'}
          </button>
        )
      )}
      {editing && handoffOnly && (
        <fieldset>
          <legend>마지막 회차 승인 위임</legend>
          <p>
            중간 추천 과제는 직접 승인합니다. 마지막 인계 문서를 다음 회차에
            전달합니다.
          </p>
          {sessionLimit}
          <label>
            종료 시각 (24시간 이내)
            <input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          </label>
          <button
            disabled={
              busy ||
              invalidLimit ||
              !(
                Date.parse(until) > Date.now() &&
                Date.parse(until) <= Date.now() + 86400000
              )
            }
            onClick={() => void save(true)}
          >
            {canRestart
              ? 'Start from handoff with auto-approval'
              : 'Enable auto-approval'}
          </button>
          <button disabled={busy} onClick={() => edit(false)}>
            Close
          </button>
        </fieldset>
      )}
      {editing && !handoffOnly && (
        <fieldset>
          <legend>완성 목표 설정</legend>
          <p>
            충족한 기준 수로 달성률을 계산합니다. 목표 달성·횟수 소진·시각 도달
            시 다음 승인 단계에서 루프가 끝납니다. 일반 검토와 질문은 직접
            결정합니다.
          </p>
          {busy && generation.current && (
            <p role="status">
              {draft
                ? '작성한 목표를 다듬고 합격 기준을 제안하고 있습니다…'
                : '첫 세션의 작업 자료에서 완성 목표를 제안하고 있습니다…'}
            </p>
          )}
          {draft && (
            <>
              {mission && (
                <details>
                  <summary>First session input</summary>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{mission}</p>
                </details>
              )}
              <label>
                완성 목표
                <textarea
                  readOnly={busy}
                  aria-label="완성 목표"
                  maxLength={500}
                  value={draft.goal}
                  onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
                />
              </label>
              <label>
                합격 기준 · 한 줄에 하나
                <textarea
                  readOnly={busy}
                  aria-label="합격 기준 · 한 줄에 하나"
                  rows={4}
                  value={lines}
                  onChange={(e) => setLines(e.target.value)}
                />
              </label>
              <label>
                목표 달성률 (%)
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={draft.target}
                  onChange={(e) =>
                    setDraft({ ...draft, target: Number(e.target.value) })
                  }
                />
              </label>
              {sessionLimit}
              <label>
                종료 시각 (24시간 이내)
                <input
                  type="datetime-local"
                  value={until}
                  onChange={(e) => setUntil(e.target.value)}
                />
              </label>
              <button
                disabled={
                  busy ||
                  !completionGoalSchema.safeParse({
                    ...draft,
                    criteria: lines
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }).success ||
                  invalidLimit ||
                  !(
                    Date.parse(until) > Date.now() &&
                    Date.parse(until) <= Date.now() + 86400000
                  )
                }
                onClick={() => void save(true)}
              >
                {canRestart
                  ? 'Start from handoff with auto-approval'
                  : 'Enable auto-approval'}
              </button>
            </>
          )}
          {!busy && (
            <button
              disabled={!!draft && !draft.goal.trim()}
              onClick={() => void propose()}
            >
              Refine goal
            </button>
          )}
          <button
            onClick={() => {
              generation.current?.abort();
              setBusy(false);
              edit(false);
              setDraft(null);
            }}
          >
            Close
          </button>
        </fieldset>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
