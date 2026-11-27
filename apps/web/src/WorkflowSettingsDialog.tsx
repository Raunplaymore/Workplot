import { useId, useRef, useState, type ReactNode } from 'react';
import { Settings2 } from 'lucide-react';
import type {
  RunView,
  WorkflowVersion,
  WorkflowDefinition,
} from '@studio/contracts';
import styles from './WorkflowSettingsDialog.module.css';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function WorkflowSettingsDialog({
  run,
  record,
  steps,
}: {
  run: RunView;
  record: WorkflowVersion | null;
  steps: WorkflowDefinition['steps'];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [activity, setActivity] = useState(false);
  const { summary, worktree } = run,
    files = summary.requestFiles,
    target = files?.gitTarget,
    definition = record?.definition;
  const stepName = (id: string) => steps.find((s) => s.id === id)?.title ?? id;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setActivity(false);
          dialog.current?.showModal();
        }}
      >
        <Settings2 size={16} aria-hidden="true" /> Workflow settings
      </button>
      <dialog ref={dialog} className={styles.dialog} aria-labelledby={title}>
        <header>
          <div>
            <h2 id={title}>Workflow settings</h2>
            <p>
              {definition?.name} · 실행 버전 v{summary.workflowVersion}
            </p>
          </div>
          <button onClick={() => dialog.current?.close()}>Close</button>
        </header>
        <div className={styles.switcher} role="group" aria-label="View">
          <button aria-pressed={!activity} onClick={() => setActivity(false)}>
            Settings
          </button>
          <button aria-pressed={activity} onClick={() => setActivity(true)}>
            Activity
          </button>
        </div>
        <div className={styles.body} key={String(activity)}>
          {activity ? (
            <>
              <section>
                <h3>AI activity</h3>
                {run.modelCalls?.length ? (
                  <ul>
                    {run.modelCalls.map((c, i) => (
                      <li key={i}>
                        {stepName(c.step)} · {c.model} · {c.effort}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>기록된 모델 호출이 없습니다.</p>
                )}
                {Boolean(run.aiCalls?.length) && (
                  <ol>
                    {run.aiCalls?.map((c, i) => (
                      <li key={i}>
                        {stepName(c.step)} · PID {c.pid} ·{' '}
                        {c.session ?? '세션 ID 미확인'}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              {target && (
                <section>
                  <h3>Development task</h3>
                  <dl>
                    <Field label="실행">{summary.id}</Field>
                    <Field label="작업">{summary.developmentTaskId}</Field>
                    {worktree && (
                      <>
                        <Field label="작업 브랜치">{worktree.branch}</Field>
                        <Field label="현재 커밋">{worktree.head}</Field>
                      </>
                    )}
                    {summary.sessionGit && (
                      <Field label="이어받은 커밋">
                        <a href={'#/runs/' + summary.sessionGit.sourceRun}>
                          Previous session
                        </a>{' '}
                        · {summary.sessionGit.head}
                      </Field>
                    )}
                    {summary.master ? (
                      <Field label="통합 결과">
                        <a href={'#/masters/' + summary.master.runId}>
                          View integration
                        </a>
                      </Field>
                    ) : (
                      files?.handoff && (
                        <Field label="통합 결과">통합 큐 등록 기록 없음</Field>
                      )
                    )}
                  </dl>
                </section>
              )}
            </>
          ) : (
            <>
              <section>
                <h3>Workflow</h3>
                <dl>
                  {!definition && (
                    <Field label="설계 정보">
                      실행 버전의 설계 정보를 불러오지 못했습니다.
                    </Field>
                  )}
                  {definition?.goal && (
                    <Field label="목표">{definition.goal}</Field>
                  )}
                  {definition?.doneWhen && (
                    <Field label="완료 기준">{definition.doneWhen}</Field>
                  )}
                  {definition && (
                    <Field label="세션 반복">
                      {definition.steps.some(
                        (s) => s.kind === 'review' && s.startNextSession,
                      )
                        ? '마지막 승인 후 다음 회차 시작'
                        : '한 회차 실행'}
                    </Field>
                  )}
                  {definition?.inputFields?.length ? (
                    <Field label="필수 입력">
                      {definition.inputFields.join(', ')}
                    </Field>
                  ) : null}
                  {summary.taskRequest && (
                    <Field label="이번 작업 요청">{summary.taskRequest}</Field>
                  )}
                </dl>
              </section>
              <section>
                <h3>AI settings</h3>
                <dl>
                  <Field label="요청 모델">
                    {summary.modelSettings?.model ?? '자동'}
                  </Field>
                  <Field label="추론 강도">
                    {summary.modelSettings?.effort ?? '자동'}
                  </Field>
                </dl>
              </section>
              <section>
                <h3>Workspace and files</h3>
                <dl>
                  {target && (
                    <>
                      <Field label="저장소">
                        {target.service} · {target.repository}
                      </Field>
                      <Field label="기준 브랜치">{target.branch}</Field>
                      <Field label="기준 커밋">
                        {target.sha} ·{' '}
                        {target.dirty
                          ? '시작 당시 미커밋 변경 있음'
                          : '시작 당시 깨끗함'}
                      </Field>
                    </>
                  )}
                  {(target?.path || files?.workspace) && (
                    <Field label="원본 폴더">
                      {target?.path ?? files?.workspace}
                    </Field>
                  )}
                  {worktree && (
                    <Field label="독립 작업 폴더">{worktree.path}</Field>
                  )}
                  {files?.references.length ? (
                    <Field label="참고 자료">
                      {files.references.join('\n')}
                    </Field>
                  ) : null}
                  {!target &&
                    !files?.workspace &&
                    !worktree &&
                    !files?.references.length && (
                      <Field label="첨부 자료">
                        지정된 파일이나 작업 폴더가 없습니다.
                      </Field>
                    )}
                </dl>
              </section>
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
