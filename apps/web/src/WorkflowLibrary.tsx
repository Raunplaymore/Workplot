import {
  readMaterialDraft,
  storeMaterialDraft,
  emptyMaterialDraft,
} from './material-draft';
import { RequestAttachments } from './RequestAttachments';
import type { RequestFiles } from '@studio/contracts';
import { useEffect, useRef, useState } from 'react';
import { AutoSession } from './AutoSession';
import { WorkflowSchedule } from './WorkflowSchedule';
import { SkillRegistration } from './SkillRegistration';
import { ActionMenu, anchorMenu, type MenuPosition } from './ActionMenu';
import { MoreHorizontal, Search, Star } from 'lucide-react';
import {
  librarySchema,
  missingInputFields,
  orderedSteps,
  requiredInputFields,
  runViewSchema,
  workflowVersionSchema,
  type RunList,
  type RunMaterial,
  type WorkflowVersion,
} from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './WorkflowLibrary.module.css';

function versionStatus(saved: number, runs: RunList | null) {
  const label = '저장 v' + saved;
  if (!runs) return label + ' · 실행 기록 확인 중';
  if (!runs.length) return label + ' · 실행 전';
  const last = runs.find((run) => run.status === 'completed');
  const completed = last
    ? '마지막 완료 v' + last.workflowVersion
    : '완료 기록 없음';
  const latest = runs.find((run) => run.workflowVersion === saved);
  if (!latest) return [label, completed, '최신 버전 실행 전'].join(' · ');
  if (latest.quotaRetryAt) return [label, '한도 대기', completed].join(' · ');
  if (latest.status === 'completed') return label + ' · ' + completed;
  if (latest.status === 'failed')
    return (
      <>
        {label} ·{' '}
        <a
          className={styles.failureLink}
          href={'#/runs/' + latest.id + '/log'}
          aria-label="최근 실행 실패 로그 열기"
        >
          최근 실행 실패
        </a>{' '}
        · {completed}
      </>
    );
  const status = {
    queued: '실행 준비 중',
    running: '실행 중',
    waiting: latest.gateKind === 'question' ? '답변 대기' : '승인 대기',
    stopped: '최근 실행 중단',
    unknown: '종료 상태 미확인',
  }[latest.status];
  return [label, status, completed].join(' · ');
}

function libraryChoice() {
  return location.hash.startsWith('#/library/')
    ? location.hash.slice('#/library/'.length)
    : '';
}
function LibraryAutoSession({ run }: { run: RunList[number] }) {
  const [eligible, setEligible] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const c = new AbortController();
    void localRequest(
      '/workflows/' +
        run.workflowId +
        '/versions/' +
        run.workflowVersion +
        '?expanded=1',
      'GET',
      undefined,
      c.signal,
    )
      .then((r) => r.json())
      .then((data) => {
        const { steps } = workflowVersionSchema.parse(data).definition;
        if (!c.signal.aborted)
          setEligible(
            steps.some((s) => s.kind === 'review' && s.startNextSession) &&
              steps.some((s) => s.kind === 'task' && s.tool === 'workplot-ui'),
          );
      })
      .catch((e: Error) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [run.workflowId, run.workflowVersion]);
  if (error) return <p role="alert">{error}</p>;
  return (
    eligible && (
      <div className={styles.autoSession}>
        <h3>
          다음 세션 자동승인 <small>실행 v{run.workflowVersion}</small>
        </h3>
        <AutoSession id={run.id} canConfigure />
      </div>
    )
  );
}

export function WorkflowLibrary({
  starting,
  rows,
  prepare,
  startSaved,
  edit,
  canEdit,
  busy,
}: {
  rows: RunList | null;
  startSaved: (
    version: WorkflowVersion,
    request?: string,
    files?: RequestFiles,
  ) => void;
  prepare: (
    version: WorkflowVersion,
    request?: string,
    files?: RequestFiles,
  ) => void;
  edit: (id: string) => void;
  canEdit: boolean;
  starting: boolean;
  busy: boolean;
}) {
  const [entries, setEntries] = useState<ReturnType<
    typeof librarySchema.parse
  > | null>(null);
  type Entry = NonNullable<typeof entries>[number];
  const [folder, setFolder] = useState<Entry['location']>('active');
  const [menu, setMenu] = useState<{
    item: Entry;
    position: MenuPosition;
  } | null>(null);
  const operation = useRef(false);
  async function act(fn: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true;
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '작업 실패');
    } finally {
      operation.current = false;
    }
  }
  async function refresh() {
    setEntries(
      librarySchema.parse(await (await localRequest('/library')).json()),
    );
  }
  async function move(item: Entry, action: 'archive' | 'restore' | 'trash') {
    await localRequest('/workflows/' + item.id + '/location', 'PUT', {
      from: item.location,
      action,
    });
    await refresh();
  }
  async function withVersion(
    item: Entry,
    fn: (v: WorkflowVersion) => void | Promise<void>,
  ) {
    const v = workflowVersionSchema.parse(
      await (await localRequest('/workflows/' + item.id)).json(),
    );
    await fn(v);
  }
  const [query, setQuery] = useState('');
  const [choice, updateChoice] = useState(libraryChoice);
  function setChoice(id: string) {
    updateChoice(id);
    location.hash = id ? '#/library/' + id : '#/library';
  }
  useEffect(() => {
    const sync = () => updateChoice(libraryChoice());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const requested = entries?.find((item) => item.id === choice);
  const currentFolder = requested?.location ?? folder;

  const [record, setRecord] = useState<WorkflowVersion | null>(null);
  const [result, setResult] = useState<{
    id: string;
    text: string;
    file: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [favBusy, setFavBusy] = useState(false);
  useEffect(() => {
    const c = new AbortController();
    localRequest('/library', 'GET', undefined, c.signal)
      .then((r) => r.json())
      .then((data) => {
        if (!c.signal.aborted) setEntries(librarySchema.parse(data));
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, []);
  const activity = new Map<string, string>();
  for (const row of rows ?? [])
    if (!activity.has(row.workflowId))
      activity.set(row.workflowId, row.recordedAt);
  const visible = (entries ?? [])
    .filter((e) => e.location === currentFolder)
    .filter((e) =>
      (e.name + ' ' + e.goal)
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        (activity.get(b.id) ?? '').localeCompare(activity.get(a.id) ?? '') ||
        b.savedAt.localeCompare(a.savedAt),
    );
  const selected = choice ? requested : visible[0];
  const id = selected?.id;
  useEffect(() => {
    if (!choice && id && !query && location.hash === '#/library') {
      window.history.replaceState(window.history.state, '', '#/library/' + id);
      updateChoice(id);
    }
  }, [choice, id, query]);
  const [requestDraft, setRequestDraft] = useState({ key: '', text: '' });
  const requestKey = id + '/' + selected?.version;
  const [filesDraft, setFilesDraft] = useState<{
    key: string;
    files: RequestFiles;
  }>();
  const files = filesDraft?.key === requestKey ? filesDraft.files : undefined;
  const attached =
    files && (files.references.length || files.workspace) ? files : undefined;
  const request = requestDraft.key === requestKey ? requestDraft.text : '';
  const selectedVersion = selected?.version;
  const runs = rows?.filter((r) => r.workflowId === id) ?? [];
  const activeRun = runs.find((r) =>
    ['queued', 'running', 'waiting'].includes(r.status),
  );
  const waiting = runs.filter((r) => r.status === 'waiting');
  const last = runs.find((r) => r.status === 'completed');
  const lastId = last?.id;
  useEffect(() => {
    const c = new AbortController();
    setRecord(null);
    setError('');
    if (id && selectedVersion)
      localRequest(
        '/workflows/' + id + '/versions/' + selectedVersion,
        'GET',
        undefined,
        c.signal,
      )
        .then((r) => r.json())
        .then((data) => {
          if (!c.signal.aborted) setRecord(workflowVersionSchema.parse(data));
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        });
    return () => c.abort();
  }, [id, selectedVersion]);
  useEffect(() => {
    const c = new AbortController();
    setResult(null);
    if (lastId)
      void (async () => {
        const state = runViewSchema.parse(
          await (
            await localRequest(
              '/runs/' + lastId + '/view',
              'GET',
              undefined,
              c.signal,
            )
          ).json(),
        );
        const file = state.results.at(-1);
        if (!file) return;
        const text = await (
          await localRequest(
            '/runs/' + lastId + '/results/' + file,
            'GET',
            undefined,
            c.signal,
          )
        ).text();
        if (!c.signal.aborted) setResult({ id: lastId, text, file });
      })().catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [lastId]);
  async function favorite(entry: NonNullable<typeof selected>) {
    setFavBusy(true);
    try {
      await localRequest('/workflows/' + entry.id + '/favorite', 'PUT', {
        favorite: !entry.favorite,
      });
      setEntries(
        (items) =>
          items?.map((item) =>
            item.id === entry.id
              ? { ...item, favorite: !entry.favorite }
              : item,
          ) ?? null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '즐겨찾기 변경 실패');
    } finally {
      setFavBusy(false);
    }
  }
  const version =
    record?.id === id && record?.version === selectedVersion ? record : null;
  return (
    <section className={styles.library} aria-label="워크플로 보관함">
      <div className={styles.list}>
        <label>
          목록{' '}
          <select
            aria-label="워크플로 위치"
            value={currentFolder}
            onChange={(e) => {
              setFolder(e.target.value as Entry['location']);
              setChoice('');
              setMenu(null);
            }}
          >
            <option value="active">내 워크플로</option>
            <option value="archived">보관함</option>
            <option value="trash">휴지통</option>
          </select>
        </label>
        <label className={styles.search}>
          <Search size={17} aria-hidden="true" />
          <input
            type="search"
            aria-label="이름 또는 목적으로 검색"
            placeholder="이름 또는 목적으로 검색"
            value={query}
            onChange={(e) => {
              setFolder(currentFolder);
              setQuery(e.target.value);
              if (choice) setChoice('');
            }}
          />
        </label>
        {entries === null ? (
          <p>목록을 불러오는 중…</p>
        ) : !visible.length ? (
          <p>
            {entries.length
              ? '검색 결과가 없습니다.'
              : '저장한 워크플로가 없습니다.'}{' '}
            {!entries.length && <a href="#/design">흐름 설계 열기</a>}
          </p>
        ) : (
          <ul>
            {visible.map((item) => {
              const history =
                rows?.filter((r) => r.workflowId === item.id) ?? null;
              const olderPending = history?.find(
                (r) =>
                  r.status === 'waiting' && r.workflowVersion !== item.version,
              );
              return (
                <li
                  key={item.id}
                  data-selected={item.id === id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setChoice(item.id);
                    setMenu({ item, position: { x: e.clientX, y: e.clientY } });
                  }}
                  onKeyDown={(e) => {
                    if (
                      (e.shiftKey && e.key === 'F10') ||
                      e.key === 'ContextMenu'
                    ) {
                      e.preventDefault();
                      setChoice(item.id);
                      setMenu({
                        item,
                        position: anchorMenu(e.target as Element),
                      });
                    }
                  }}
                >
                  <button
                    onClick={() => void favorite(item)}
                    aria-pressed={item.favorite}
                    aria-label={item.name + ' 즐겨찾기'}
                    disabled={favBusy}
                  >
                    <Star
                      size={16}
                      fill={item.favorite ? 'currentColor' : 'none'}
                      aria-hidden="true"
                    />
                  </button>
                  <div className={styles.itemInfo}>
                    <button
                      aria-pressed={item.id === id}
                      onClick={() => setChoice(item.id)}
                    >
                      <strong>{item.name}</strong>
                    </button>
                    <small>
                      {versionStatus(item.version, history)}
                      {olderPending &&
                        ' · v' +
                          olderPending.workflowVersion +
                          (olderPending.gateKind === 'question'
                            ? ' 답변 대기'
                            : ' 승인 대기')}
                    </small>
                  </div>
                  <button
                    type="button"
                    aria-label={item.name + ' 메뉴'}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      setChoice(item.id);
                      setMenu({ item, position: anchorMenu(e.currentTarget) });
                    }}
                  >
                    <MoreHorizontal size={17} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {menu && (
        <ActionMenu
          position={menu.position}
          close={() => setMenu(null)}
          label={menu.item.name + ' 작업'}
          items={[
            ...(menu.item.location !== 'trash'
              ? [
                  {
                    label: '새 자료로 실행…',
                    disabled: busy,
                    action: () =>
                      void act(() => withVersion(menu.item, prepare)),
                  },
                  {
                    label: '저장된 자료로 실행',
                    disabled:
                      busy ||
                      !version?.definition.input?.trim() ||
                      version.definition.steps.some(
                        (s) => s.kind === 'task' && s.agent === 'unassigned',
                      ),
                    action: () =>
                      void act(() => withVersion(menu.item, startSaved)),
                  },
                  {
                    label: '편집',
                    divider: true,
                    disabled: !canEdit,
                    action: () => edit(menu.item.id),
                  },
                  {
                    label: '복제',
                    action: () =>
                      void act(() =>
                        withVersion(menu.item, async (v) => {
                          const duplicate = workflowVersionSchema.parse(
                            await (
                              await localRequest('/workflows', 'POST', {
                                ...v.definition,
                                name:
                                  v.definition.name.slice(0, 90) + ' 복사본',
                              })
                            ).json(),
                          );
                          await refresh();
                          setQuery('');
                          setFolder('active');
                          setChoice(duplicate.id);
                        }),
                      ),
                  },
                ]
              : []),
            menu.item.location === 'active'
              ? {
                  label: '보관함으로 이동',
                  hint: '예약 유지',
                  divider: true,
                  action: () => void act(() => move(menu.item, 'archive')),
                }
              : {
                  label: '복원',
                  divider: menu.item.location !== 'trash',
                  hint:
                    menu.item.location === 'trash'
                      ? '원래 목록으로 복원 · 예약은 정지 상태'
                      : undefined,
                  action: () => void act(() => move(menu.item, 'restore')),
                },
            ...(menu.item.location !== 'trash'
              ? [
                  {
                    label: '휴지통으로 이동',
                    hint: '예약 일시정지',
                    danger: true,
                    action: () => void act(() => move(menu.item, 'trash')),
                  },
                ]
              : []),
          ]}
        />
      )}
      <article className={styles.detail}>
        {choice && entries && !requested && (
          <p role="alert">이 주소의 워크플로를 찾을 수 없습니다.</p>
        )}
        {error && <p role="alert">{error}</p>}
        {version && (
          <>
            <header>
              <div>
                <small>
                  {versionStatus(version.version, rows ? runs : null)}
                </small>
                <h2>{version.definition.name}</h2>
              </div>
              <button
                onClick={() => edit(version.id)}
                disabled={!canEdit || currentFolder === 'trash'}
              >
                흐름 편집
              </button>
            </header>
            {version.definition.goal && <p>{version.definition.goal}</p>}
            <h3>작업 순서</h3>
            <p>
              {orderedSteps(version.definition)
                .map((s) => s.title)
                .join(' → ')}
            </p>
            <h3>필요한 자료</h3>
            <p>
              {requiredInputFields(version.definition).join(' · ') ||
                '이번 작업의 원본 자료'}
            </p>
            {currentFolder !== 'trash' && (
              <>
                <label className={styles.taskRequest}>
                  이번 작업 요청 <small>선택</small>
                  <textarea
                    rows={2}
                    maxLength={2000}
                    value={request}
                    placeholder="이번 실행에서 맡길 일을 적어 주세요."
                    onChange={(e) =>
                      setRequestDraft({ key: requestKey, text: e.target.value })
                    }
                  />
                </label>
                <RequestAttachments
                  key={requestKey}
                  value={files ?? { references: [] }}
                  change={(files) => setFilesDraft({ key: requestKey, files })}
                />
                <div className={styles.runActions}>
                  {version.definition.input?.trim() && (
                    <button
                      className={styles.primary}
                      disabled={
                        busy ||
                        version.definition.steps.some(
                          (s) => s.kind === 'task' && s.agent === 'unassigned',
                        )
                      }
                      onClick={() =>
                        startSaved(
                          version,
                          request.trim() || undefined,
                          attached,
                        )
                      }
                    >
                      {starting ? '실행 접수 중…' : '저장된 자료로 실행'}
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      prepare(version, request.trim() || undefined, attached)
                    }
                  >
                    새 자료로 실행
                  </button>
                </div>
                {activeRun && (
                  <LibraryAutoSession key={activeRun.id} run={activeRun} />
                )}
                <WorkflowSchedule
                  key={version.id + version.version}
                  flow={version}
                />
                <SkillRegistration
                  key={version.id + ':' + version.version}
                  flow={version}
                />
              </>
            )}
            {waiting.map((row) => (
              <p key={row.id}>
                <a href={'#/runs/' + row.id + '/review'}>
                  {row.gateKind === 'question'
                    ? '질문에 답하기'
                    : '검토 이어가기'}{' '}
                  · {row.name}
                </a>
              </p>
            ))}
            {last && (
              <>
                <h3>마지막 완성 문서</h3>
                <a href={'#/runs/' + last.id}>
                  {last.name} · v{last.workflowVersion} 결과 열기
                </a>
                {result?.id === last.id && (
                  <pre aria-label="마지막 결과 미리보기">{result.text}</pre>
                )}
              </>
            )}
            {runs.length > 1 && (
              <details className={styles.history}>
                <summary>실행 기록 ({runs.length})</summary>
                <ul>
                  {runs.map((row) => (
                    <li key={row.id}>
                      <a href={'#/runs/' + row.id}>
                        {row.name} · v{row.workflowVersion}
                      </a>{' '}
                      <time dateTime={row.recordedAt}>
                        {new Date(row.recordedAt).toLocaleString('ko-KR')}
                      </time>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </article>
    </section>
  );
}

export function MaterialDialog({
  version,
  busy,
  start,
  close,
  error,
}: {
  version: WorkflowVersion;
  busy: boolean;
  start: (v: WorkflowVersion, m: RunMaterial) => void;
  close: () => void;
  error: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => readMaterialDraft(version));
  const [stored, setStored] = useState(true);
  const { name, paste, answers } = draft;
  function update(next: typeof draft) {
    setDraft(next);
    setStored(storeMaterialDraft(version, next));
  }
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const fields = requiredInputFields(version.definition);
  const remaining = missingInputFields(fields, paste);
  const source = [
    paste.trim(),
    ...remaining
      .filter((k) => answers[k]?.trim())
      .map((k) => k + ': ' + answers[k]!.trim()),
  ]
    .filter(Boolean)
    .join('\n');
  const missing = missingInputFields(fields, source);
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby="material-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <small>
        {version.definition.name} · v{version.version}
      </small>
      <h2 id="material-title">새 자료로 실행</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (source && source.length <= 8000 && !missing.length)
            start(version, { source, name: name.trim() });
        }}
      >
        <label>
          이번 작업 이름 (선택)
          <input
            value={name}
            disabled={busy}
            maxLength={100}
            onChange={(e) => update({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          이번 작업 자료
          <textarea
            rows={4}
            disabled={busy}
            maxLength={8000}
            value={paste}
            onChange={(e) => update({ ...draft, paste: e.target.value })}
            placeholder={
              fields.length
                ? fields.map((key) => key + ': …').join('\n')
                : '이번에 사용할 자료를 붙여 넣으세요.'
            }
          />
        </label>
        {remaining.map((k) => (
          <label key={k}>
            {k}
            <input
              required
              value={answers[k] ?? ''}
              disabled={busy}
              maxLength={8000}
              onChange={(e) =>
                update({
                  ...draft,
                  answers: { ...answers, [k]: e.target.value },
                })
              }
            />
          </label>
        ))}
        {source.length > 8000 && (
          <p role="alert">자료는 8,000자까지 입력할 수 있습니다.</p>
        )}
        {error && <p role="alert">{error}</p>}
        {source && (
          <details>
            <summary>실행에 전달할 자료</summary>
            <pre className={styles.materialPreview}>{source}</pre>
          </details>
        )}
        {!stored && (
          <p role="alert">
            이 탭에 입력을 저장할 수 없습니다. 닫기 전에 자료를 복사하세요.
          </p>
        )}
        <div role="status" aria-live="polite" aria-atomic="true">
          {busy && <p>실행 접수 중…</p>}
          {missing.length > 0 && (
            <p>입력이 필요한 필수 항목: {missing.join(', ')}</p>
          )}
        </div>
        <footer>
          {(name || paste || Object.values(answers).some(Boolean)) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => update(emptyMaterialDraft)}
            >
              입력 지우기
            </button>
          )}
          <button type="button" disabled={busy} onClick={close}>
            닫기
          </button>
          <button
            className={styles.primary}
            disabled={
              busy || !source || source.length > 8000 || missing.length > 0
            }
          >
            {busy ? '실행 접수 중…' : '실행 시작'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
