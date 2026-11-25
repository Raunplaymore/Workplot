import { useEffect, useRef, useState } from 'react';
import {
  gitTargetSchema,
  type GitTarget,
  type WorkflowDefinition,
  type RunView,
} from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './WorkflowLibrary.module.css';
type Binding = Pick<
  GitTarget,
  'service' | 'serviceId' | 'checkoutId' | 'repositoryId' | 'path'
>;
function label(t: GitTarget) {
  return [t.service, t.repository, t.subpath === '.' ? '' : t.subpath]
    .filter(Boolean)
    .join(' › ');
}
type ProjectFolder = NonNullable<WorkflowDefinition['projectFolder']>;
async function folderKey(path: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(path),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
export async function projectFolder(target: GitTarget): Promise<ProjectFolder> {
  return {
    service: target.service,
    serviceId: target.serviceId,
    checkoutId: target.checkoutId,
    folderKey: await folderKey(target.path),
    folder: target.path.split('/').filter(Boolean).at(-1) || '/',
    branch: target.branch,
  };
}
async function inspectBinding(binding: Binding) {
  const { location } = await (
    await localRequest('/git/inspect', 'POST', { path: binding.path })
  ).json();
  if (
    !location ||
    location.checkoutId !== binding.checkoutId ||
    location.repositoryId !== binding.repositoryId
  )
    throw Error(
      '등록 시점과 다른 저장소입니다. 현재 폴더를 확인하고 새 대상으로 등록하세요.',
    );
  return gitTargetSchema.parse({
    ...location,
    service: binding.service,
    serviceId: binding.serviceId,
  });
}
export function GitRun({
  folder,
  project,
  configuring = false,
  request,
  flow,
  onStart,
  onClose,
  busy,
  error,
}: {
  folder: string;
  project?: ProjectFolder;
  configuring?: boolean;
  request: string;
  flow: string;
  onStart: (target: GitTarget, text: string) => void;
  onClose: () => void;
  busy: boolean;
  error: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [bindings, setBindings] = useState<Binding[]>([]),
    [path, setPath] = useState(folder),
    [name, setName] = useState(''),
    [text, setText] = useState(request),
    [preview, setPreview] = useState<GitTarget>(),
    [pending, setPending] = useState(false),
    [issue, setIssue] = useState('');
  const title = configuring ? '기본 프로젝트 폴더 연결' : '개발 작업 실행';
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    setPending(true);
    localRequest('/git/targets')
      .then((r) => r.json())
      .then(async (b: Binding[]) => {
        if (!active) return;
        setBindings(b);
        if (!project || folder) return;
        for (const binding of b) {
          if (
            binding.serviceId !== project.serviceId ||
            binding.checkoutId !== project.checkoutId ||
            (await folderKey(binding.path)) !== project.folderKey
          )
            continue;
          if (!active) return;
          setName(binding.service);
          setPath(binding.path);
          const target = await inspectBinding(binding);
          if (active) setPreview(target);
          return;
        }
        throw Error(
          '기본 프로젝트 폴더를 찾을 수 없습니다. 실행 대상을 다시 선택하세요.',
        );
      })
      .catch((e) => {
        if (active) setIssue(e.message);
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [project, folder]);
  async function action(work: () => Promise<void>) {
    setIssue('');
    setPending(true);
    try {
      await work();
    } catch (e) {
      setIssue(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  }
  async function select(binding: Binding) {
    setPreview(undefined);
    setName(binding.service);
    setPath(binding.path);
    setPreview(await inspectBinding(binding));
  }
  const locked = busy || pending;
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!locked) onClose();
      }}
    >
      <small>{flow}</small>
      <h2>{title}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (preview && !locked) onStart(preview, text.trim());
        }}
      >
        <fieldset disabled={locked} className={styles.gitFields}>
          {bindings.length > 0 && (
            <label>
              등록된 실행 대상
              <select
                value={
                  preview
                    ? bindings.findIndex(
                        (b) =>
                          b.path === preview.path &&
                          b.checkoutId === preview.checkoutId &&
                          b.serviceId === preview.serviceId,
                      )
                    : ''
                }
                onChange={(e) => {
                  const b = bindings[Number(e.target.value)];
                  if (e.target.value && b) void action(() => select(b));
                  else setPreview(undefined);
                }}
              >
                <option value="">대상 선택</option>
                {bindings.map((b, i) => (
                  <option key={b.serviceId + b.checkoutId + b.path} value={i}>
                    {b.service} · {b.path}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            서비스 이름
            <input
              value={name}
              maxLength={100}
              onChange={(e) => {
                setName(e.target.value);
                setPreview(undefined);
              }}
            />
          </label>
          <label>
            서비스 작업 폴더
            <input
              value={path}
              placeholder="Git 저장소 또는 서비스 하위 폴더"
              onChange={(e) => {
                setPath(e.target.value);
                setPreview(undefined);
              }}
            />
          </label>
          <div>
            <button
              type="button"
              onClick={() =>
                void action(async () => {
                  const selected = await (
                    await localRequest('/request-files/choose', 'POST', {
                      kind: 'folder',
                    })
                  ).json();
                  if (selected.path) {
                    setPreview(undefined);
                    setPath(selected.path);
                  }
                })
              }
            >
              폴더 선택
            </button>{' '}
            <button
              type="button"
              disabled={!name.trim() || !path.trim()}
              onClick={() =>
                void action(async () => {
                  setPreview(undefined);
                  const v = gitTargetSchema.parse(
                    await (
                      await localRequest('/git/targets', 'POST', {
                        service: name.trim(),
                        path: path.trim(),
                      })
                    ).json(),
                  );
                  setBindings(
                    await (await localRequest('/git/targets')).json(),
                  );
                  setPreview(v);
                })
              }
            >
              등록 · 대상 확인
            </button>
          </div>
          {preview && (
            <div role="status">
              <strong>{label(preview)}</strong>
              <p>
                {preview.branch} · <code>{preview.sha.slice(0, 12)}</code>
                {preview.dirty
                  ? ' · 원본에 미커밋 변경 있음'
                  : ' · 깨끗한 작업 트리'}
              </p>
              <p>
                표시한 커밋에서 독립 작업 폴더를 만듭니다. 원본의 미커밋 변경은
                원본에 남습니다.
              </p>
            </div>
          )}
          {!configuring && (
            <label>
              이번 작업 요청
              <textarea
                rows={2}
                maxLength={2000}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
          )}
        </fieldset>
        {(issue || error) && <p role="alert">{issue || error}</p>}
        <footer>
          <button type="button" disabled={locked} onClick={onClose}>
            취소
          </button>
          <button className={styles.primary} disabled={!preview || locked}>
            {configuring ? '이 폴더 연결' : '이 대상으로 실행'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
export function GitRunInfo({ run }: { run: RunView }) {
  const target = run.summary.requestFiles?.gitTarget;
  if (!target) return null;
  return (
    <section>
      <h3>개발 작업</h3>
      <strong>{label(target)}</strong>
      <p>
        {target.branch} · {target.sha.slice(0, 12)}
      </p>
      {run.summary.sessionGit && (
        <p>
          <a href={'#/runs/' + run.summary.sessionGit.sourceRun}>직전 회차</a>
          에서 이어받은 커밋 ·{' '}
          <code>{run.summary.sessionGit.head.slice(0, 12)}</code>
        </p>
      )}
      {run.summary.requestFiles?.handoff && run.worktree && (
        <p>
          작업 브랜치 <code>{run.worktree.branch}</code> · 현재 HEAD{' '}
          <code>{run.worktree.head}</code>
          {run.summary.master ? (
            <a href={'#/masters/' + run.summary.master.runId}>
              통합 검증과 반영 결과
            </a>
          ) : (
            ' · 통합 큐 등록 기록 없음'
          )}
        </p>
      )}
      <details>
        <summary>작업 및 AI 호출 기록</summary>
        <p>작업 {run.summary.developmentTaskId}</p>
        <p>
          흐름 v{run.summary.workflowVersion} · 실행 {run.summary.id}
        </p>
        <p>원본 폴더 {target.path}</p>
        {run.worktree && (
          <>
            <p>독립 작업 폴더 {run.worktree.path}</p>
            <p>
              작업 브랜치 {run.worktree.branch} · 현재 커밋{' '}
              <code>{run.worktree.head}</code>
            </p>
          </>
        )}
        <p>
          원본 기준 커밋 <code>{target.sha}</code> ·{' '}
          {target.dirty ? '시작 당시 미커밋 변경 있음' : '시작 당시 깨끗함'}
        </p>
        {run.aiCalls?.length ? (
          <ol>
            {run.aiCalls.map((call, i) => (
              <li key={i}>
                {call.step} · PID {call.pid} ·{' '}
                {call.session ?? '세션 ID 미확인'}
              </li>
            ))}
          </ol>
        ) : (
          <p>기록된 AI 호출이 없습니다.</p>
        )}
      </details>
    </section>
  );
}
