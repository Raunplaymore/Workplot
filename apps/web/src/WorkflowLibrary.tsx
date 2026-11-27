import { WorkflowUsage } from './WorkflowLinks';
import {
  downloadWorkflow,
  WorkflowImport,
  WorkflowOrigin,
} from './WorkflowPackage';
import {
  readMaterialDraft,
  storeMaterialDraft,
  emptyMaterialDraft,
} from './material-draft';
import { RequestAttachments } from './RequestAttachments';
import type { RequestFiles } from '@studio/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { AutoSession } from './AutoSession';
import { WorkflowSchedule } from './WorkflowSchedule';
import { SkillRegistration } from './SkillRegistration';
import { ActionMenu, anchorMenu, type MenuPosition } from './ActionMenu';
import { ChevronDown, MoreHorizontal, Search, Star } from 'lucide-react';
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

function versionStatus(saved: number, runs: RunList | null, detail = false) {
  const prefix = detail ? '' : '저장 v' + saved + ' · ';
  if (!runs) return prefix + '실행 기록 확인 중';
  if (!runs.length) return prefix + '실행 전';
  const last = runs.find((run) => run.status === 'completed');
  const completed = last
    ? '마지막 완료 v' + last.workflowVersion
    : '완료 기록 없음';
  const latest = runs.find((run) => run.workflowVersion === saved);
  if (!latest) return prefix + completed + ' · 최신 버전 실행 전';
  if (latest.quotaRetryAt) return prefix + '한도 대기 · ' + completed;
  if (latest.status === 'completed') return prefix + completed;
  if (latest.status === 'failed')
    return (
      <>
        {prefix}
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
  return prefix + status + ' · ' + completed;
}

function libraryChoice() {
  return location.hash.startsWith('#/library/')
    ? location.hash.slice('#/library/'.length).split('?')[0]!
    : '';
}
function LibraryAutoSession({ run }: { run: RunList[number] }) {
  const [eligible, setEligible] = useState(false);
  const [handoffOnly, setHandoffOnly] = useState(false);
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
        if (!c.signal.aborted) {
          setEligible(
            steps.some((s) => s.kind === 'review' && s.startNextSession),
          );
          setHandoffOnly(
            !steps.some((s) => s.kind === 'task' && s.tool === 'workplot-ui'),
          );
        }
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
        <AutoSession id={run.id} canConfigure handoffOnly={handoffOnly} />
      </div>
    )
  );
}

export function WorkflowLibrary({
  modelControl,
  starting,
  rows,
  prepare,
  startSaved,
  develop,
  developmentBusy,
  slotInfo,
  edit,
  editSettings,
  canEdit,
  busy,
}: {
  rows: RunList | null;
  developmentBusy: boolean;
  slotInfo: React.ReactNode;
  modelControl: React.ReactNode;
  develop: (
    version: WorkflowVersion,
    request?: string,
    files?: RequestFiles,
  ) => void;
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
  editSettings: (id: string) => void;
  canEdit: boolean;
  starting: boolean;
  busy: boolean;
}) {
  const [entries, setEntries] = useState<ReturnType<
    typeof librarySchema.parse
  > | null>(null);
  type Entry = NonNullable<typeof entries>[number];
  function readFolder(): Entry['location'] {
    const f = new URLSearchParams(location.hash.split('?')[1]).get('folder');
    return f === 'archived' || f === 'trash' ? f : 'active';
  }
  const [folder, setFolder] = useState(readFolder);
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
  const [query, setQuery] = useState(
    () => new URLSearchParams(location.hash.split('?')[1]).get('q') ?? '',
  );
  const [choice, updateChoice] = useState(libraryChoice);
  const [revealChoice, setRevealChoice] = useState('');
  const libraryRef = useRef<HTMLElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  function setChoice(
    id: string,
    revealDetail = false,
    nextQuery = query,
    nextFolder = folder,
    replace = false,
  ) {
    const params = new URLSearchParams();
    if (nextQuery) params.set('q', nextQuery);
    if (nextFolder !== 'active') params.set('folder', nextFolder);
    updateChoice(id);
    setRevealChoice(revealDetail ? id : '');
    const url =
      '#/library' + (id ? '/' + id : '') + (params.size ? '?' + params : '');
    if (url !== location.hash)
      window.history[replace ? 'replaceState' : 'pushState'](
        window.history.state,
        '',
        url,
      );
  }
  useEffect(() => {
    const sync = () => {
      updateChoice(libraryChoice());
      setFolder(readFolder());
      setQuery(new URLSearchParams(location.hash.split('?')[1]).get('q') ?? '');
      setMenu(null);
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const requested = entries?.find((item) => item.id === choice);
  const currentFolder = requested?.location ?? folder;

  const [record, setRecord] = useState<WorkflowVersion | null>(null);
  const [savedInputOpen, setSavedInputOpen] = useState(false);
  const savedInputPanelId = useId();
  const savedInputHeadingId = useId();
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
  const folderEntries = (entries ?? []).filter(
    (entry) => entry.location === currentFolder,
  );
  const visible = folderEntries
    .filter((e) =>
      [e.name, e.goal, e.project, ...(e.tags ?? []).map((tag) => '#' + tag)]
        .filter(Boolean)
        .join(' ')
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
    if (!choice && id && location.hash.split('?')[0] === '#/library') {
      setChoice(id, false, query, folder, true);
    }
  }, [choice, id, query, folder]);
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
    setSavedInputOpen(false);
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
  useEffect(() => {
    document.title = version
      ? version.definition.name + ' · Library · Workplot'
      : 'Library · Workplot';
  }, [version]);
  const savedInput = version?.definition.input;
  useEffect(() => {
    if (!revealChoice) return;
    if (revealChoice === choice && !version) return;
    setRevealChoice('');
    const library = libraryRef.current;
    const summary = summaryRef.current;
    if (revealChoice !== choice || !library || !summary) return;
    const view = library.getBoundingClientRect();
    const bounds = summary.getBoundingClientRect();
    summary.focus({ preventScroll: true });
    if (bounds.top < view.top || bounds.bottom > view.bottom) {
      summary.focus({ preventScroll: true });
      summary.scrollIntoView({ block: 'start' });
    }
  }, [choice, revealChoice, version]);
  return (
    <section
      ref={libraryRef}
      className={styles.library}
      aria-label="워크플로 보관함"
    >
      <div className={styles.list}>
        <WorkflowImport
          imported={async (flow) => {
            await refresh();
            setRecord(flow);
            setQuery('');
            setFolder('active');
            setChoice(flow.id, true, '', 'active');
          }}
        />
        <label>
          목록{' '}
          <select
            aria-label="워크플로 위치"
            value={currentFolder}
            onChange={(e) => {
              setFolder(e.target.value as Entry['location']);
              setChoice('', false, query, e.target.value as Entry['location']);
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
            aria-label="Search by name, goal, project or tag"
            placeholder="Name, goal, project or tag"
            value={query}
            onChange={(e) => {
              setFolder(currentFolder);
              setQuery(e.target.value);
              setChoice('', false, e.target.value, currentFolder, true);
            }}
          />
        </label>
        {entries === null ? (
          error ? (
            <p role="alert">
              목록을 가져오지 못했습니다.{' '}
              <button
                onClick={() => {
                  setError('');
                  void act(refresh);
                }}
              >
                Retry
              </button>
            </p>
          ) : (
            <p>목록을 불러오는 중…</p>
          )
        ) : !visible.length ? (
          <p>
            {currentFolder === 'archived' && !folderEntries.length
              ? '보관한 워크플로가 없습니다.'
              : entries.length
                ? '검색 결과가 없습니다.'
                : '저장한 워크플로가 없습니다.'}{' '}
            {query && (
              <button
                onClick={() => {
                  setQuery('');
                  setChoice('', false, '', currentFolder, true);
                }}
              >
                Clear search
              </button>
            )}
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
                    data-tip={
                      item.favorite
                        ? 'Remove from favorites'
                        : 'Add to favorites'
                    }
                    aria-pressed={item.favorite}
                    aria-label={item.name + ' · Toggle favorite'}
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
                      onClick={() => setChoice(item.id, true)}
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
                    aria-label={item.name + ' · Menu'}
                    data-tip="Workflow actions"
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
                    label: 'Run with new input…',
                    disabled: busy,
                    action: () =>
                      void act(() => withVersion(menu.item, prepare)),
                  },
                  {
                    label: 'Run saved input',
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
                    label: 'Edit',
                    divider: true,
                    disabled: !canEdit,
                    action: () => edit(menu.item.id),
                  },
                  {
                    label: 'Export workflow',
                    action: () => void act(() => downloadWorkflow(menu.item)),
                  },
                  {
                    label: 'Duplicate',
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
                  label: 'Move to archive',
                  hint: 'Keep schedule',
                  divider: true,
                  action: () => void act(() => move(menu.item, 'archive')),
                }
              : {
                  label: 'Restore',
                  divider: menu.item.location !== 'trash',
                  hint:
                    menu.item.location === 'trash'
                      ? 'Restore to original list with schedule paused'
                      : undefined,
                  action: () => void act(() => move(menu.item, 'restore')),
                },
            ...(menu.item.location !== 'trash'
              ? [
                  {
                    label: 'Move to trash',
                    hint: 'Pause schedule',
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
        {entries && error && <p role="alert">{error}</p>}
        {version && (
          <>
            <div ref={summaryRef} tabIndex={-1}>
              <header>
                <div className={styles.summaryInfo}>
                  <h2>{version.definition.name}</h2>
                  <WorkflowOrigin
                    key={version.id + '/' + version.version}
                    flow={version}
                  />
                  {version.definition.project ||
                  version.definition.tags?.length ? (
                    <small aria-label="Classification">
                      {[
                        version.definition.project,
                        ...(version.definition.tags ?? []).map(
                          (tag) => '#' + tag,
                        ),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  ) : null}
                  {version.definition.goal && <p>{version.definition.goal}</p>}
                  <button
                    onClick={() => edit(version.id)}
                    disabled={!canEdit || currentFolder === 'trash'}
                  >
                    Edit saved v{version.version}
                  </button>
                  <small>
                    {versionStatus(version.version, rows ? runs : null, true)}
                  </small>
                </div>
                {currentFolder !== 'trash' && (
                  <div
                    className={styles.summaryActions}
                    data-preview-open={savedInputOpen}
                  >
                    {savedInput?.trim() && (
                      <>
                        <button
                          type="button"
                          className={styles.savedInputToggle}
                          aria-expanded={savedInputOpen}
                          aria-controls={savedInputPanelId}
                          onClick={() => setSavedInputOpen(!savedInputOpen)}
                        >
                          Saved input
                          <ChevronDown size={16} aria-hidden="true" />
                        </button>
                        <div
                          id={savedInputPanelId}
                          className={styles.savedInputPanel}
                          hidden={!savedInputOpen}
                        >
                          {savedInputOpen && (
                            <>
                              <h3 id={savedInputHeadingId}>
                                Saved input · v{version.version}
                              </h3>
                              <pre
                                role="region"
                                aria-labelledby={savedInputHeadingId}
                                tabIndex={0}
                              >
                                {savedInput}
                              </pre>
                            </>
                          )}
                        </div>
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={
                            busy ||
                            version.definition.steps.some(
                              (s) =>
                                s.kind === 'task' && s.agent === 'unassigned',
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
                          {starting ? 'Starting…' : 'Run saved input'}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className={styles.primary}
                      aria-haspopup="dialog"
                      disabled={busy}
                      onClick={() =>
                        prepare(version, request.trim() || undefined, attached)
                      }
                    >
                      New input
                    </button>
                    {busy &&
                      rows?.some((r) =>
                        ['running', 'queued', 'waiting', 'unknown'].includes(
                          r.status,
                        ),
                      ) && (
                        <small>
                          일반 실행은 진행 중인 작업이 끝난 뒤 사용할 수
                          있습니다.
                        </small>
                      )}
                    <button
                      disabled={
                        developmentBusy ||
                        version.definition.steps.some(
                          (s) => s.kind === 'task' && s.agent === 'unassigned',
                        )
                      }
                      onClick={() =>
                        develop(version, request.trim() || undefined, attached)
                      }
                    >
                      Run development task
                    </button>
                    {slotInfo}
                  </div>
                )}
              </header>
            </div>
            <WorkflowUsage
              key={version.id + '/' + version.version}
              id={version.id}
            />
            <h3>작업 순서</h3>
            <p>
              {orderedSteps(version.definition)
                .map((s) => s.title)
                .join(' → ')}
            </p>
            <button
              disabled={!canEdit || currentFolder === 'trash'}
              className={styles.secondaryAction}
              onClick={() => editSettings(version.id)}
            >
              Loop settings ·{' '}
              {version.definition.steps.some(
                (s) => s.kind === 'review' && s.startNextSession,
              )
                ? 'Next session after approval'
                : 'Run once'}
            </button>
            <h3>필요한 자료</h3>
            <p>
              {requiredInputFields(version.definition).join(' · ') ||
                '이번 작업의 원본 자료'}
            </p>
            {currentFolder !== 'trash' && (
              <>
                {modelControl}
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
                  Open result · {last.name} · v{last.workflowVersion}
                </a>
                {result?.id === last.id && (
                  <pre aria-label="마지막 결과 미리보기">{result.text}</pre>
                )}
              </>
            )}
            {runs.length > 1 && (
              <details className={styles.history}>
                <summary>Run history ({runs.length})</summary>
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
  goal,
  taskRequest,
  changeRequest,
  version,
  busy,
  start,
  close,
  error,
}: {
  version: WorkflowVersion;
  busy: boolean;
  goal?: string;
  taskRequest?: string;
  changeRequest: (value: string | undefined) => void;
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
        if (busy) return;
        // Let the browser restore focus before React removes the dialog.
        e.currentTarget.close();
        close();
      }}
    >
      <small>
        {version.definition.name} · v{version.version}
      </small>
      <h2 id="material-title">새 자료로 실행</h2>
      {goal && (
        <section aria-label="Original goal">
          <h3>Original goal</h3>
          <p>{goal}</p>
          <label>
            <input
              type="checkbox"
              checked={taskRequest !== undefined}
              onChange={(e) =>
                changeRequest(e.target.checked ? goal : undefined)
              }
            />
            Use goal as task request
          </label>
        </section>
      )}
      {taskRequest !== undefined && (
        <label>
          Task request
          <textarea
            aria-label="Task request"
            value={taskRequest}
            onChange={(e) => changeRequest(e.target.value)}
          />
        </label>
      )}
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
            <summary>Run input</summary>
            <pre className={styles.materialPreview}>{source}</pre>
          </details>
        )}
        {!stored && (
          <p role="alert">
            이 탭에 입력을 저장할 수 없습니다. 닫기 전에 자료를 복사하세요.
          </p>
        )}
        <div role="status" aria-live="polite" aria-atomic="true">
          {busy && <p>Starting…</p>}
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
              Clear input
            </button>
          )}
          <button type="button" disabled={busy} onClick={close}>
            Close
          </button>
          <button
            className={styles.primary}
            disabled={
              busy || !source || source.length > 8000 || missing.length > 0
            }
          >
            {busy ? 'Starting…' : 'Start run'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
