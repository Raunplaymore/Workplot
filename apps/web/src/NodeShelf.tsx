import { useEffect, useRef, useState } from 'react';
import { Star, Trash2, X } from 'lucide-react';
import {
  fitSchema,
  fitContext,
  insertFittedNode,
  nodeTemplateSchema,
  orderedSteps,
  shelfEntrySchema,
  templateFromStep,
  workflowPlan,
  type NodeFit,
  type NodeTemplate,
  type ShelfEntry,
  type WorkflowDefinition,
} from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './NodeShelf.module.css';

export function NodeShelf({
  definition,
  after,
  selected,
  mode,
  close,
  apply,
}: {
  definition: WorkflowDefinition;
  after: string;
  selected: string;
  mode: 'save' | 'browse';
  close: () => void;
  apply: (d: WorkflowDefinition, id: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const savedSlot = useRef<HTMLButtonElement>(null);
  const [feedback, setFeedback] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [catalogReady, setCatalogReady] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [entries, setEntries] = useState<ShelfEntry[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [panel, setPanel] = useState<'save' | 'browse' | 'custom' | 'preview'>(
    mode,
  );
  const [template, setTemplate] = useState<NodeTemplate>(() =>
    templateFromStep(definition, selected),
  );
  const [fit, setFit] = useState<NodeFit | null>(null);
  const [origin, setOrigin] = useState<ShelfEntry | undefined>();
  const [pass, setPass] = useState(false);
  const selectedStep = definition.steps.find((n) => n.id === selected)!;
  const ordered = orderedSteps(definition);
  const index = ordered.findIndex((n) => n.id === after);
  const next = ordered[index + 1];
  const writer = ordered.slice(index + 1).find((n) => n.kind === 'task');
  const canPass =
    !!writer &&
    (workflowPlan(definition).steps.find((n) => n.id === writer.id)?.inputs
      .length ?? 0) < 4;
  const sources = ordered.slice(0, index + 1).filter((n) => n.kind === 'task');
  async function refresh() {
    const list = shelfEntrySchema
      .array()
      .parse(await (await localRequest('/node-shelf')).json());
    setEntries(list);
    return list;
  }
  const legacy =
    mode === 'save' &&
    selectedStep.kind === 'task' &&
    !selectedStep.templateDocuments &&
    selectedStep.templateOrigin;
  const preparingLegacy = !!legacy && !catalogReady;
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    let active = true;
    void refresh()
      .then((list) => {
        if (!active) return;
        const original =
          legacy &&
          list.find(
            (item) => item.id === legacy.id && item.version === legacy.version,
          )?.template;
        if (original && original.kind === 'task')
          setTemplate((current) =>
            current.kind === 'task'
              ? { ...current, needs: original.needs, output: original.output }
              : current,
          );
        setCatalogReady(true);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
      controller.current?.abort();
      el.close();
    };
  }, [legacy]);
  useEffect(() => {
    if (panel === 'browse' && feedback && savedSlot.current) {
      savedSlot.current.focus();
    } else heading.current?.focus();
  }, [panel, feedback]);
  async function act(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError'))
        setError(e instanceof Error ? e.message : '요청에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }
  async function propose(t: NodeTemplate, entry?: ShelfEntry) {
    await act(async () => {
      const checked = nodeTemplateSchema.safeParse(t);
      if (!checked.success)
        throw new Error(
          '이름, 작업 지침, 결과 문서와 필요한 자료(최대 4개)를 확인하세요.',
        );
      fitContext(definition, after);
      const c = new AbortController();
      controller.current = c;
      const result = await (
        await localRequest(
          '/node-fit',
          'POST',
          { definition, after, template: checked.data },
          c.signal,
        )
      ).json();
      setFit(checked.data.kind === 'task' ? fitSchema.parse(result.fit) : null);
      setTemplate(checked.data);
      setOrigin(entry);
      setPass(canPass);
      setPanel('preview');
    });
  }
  function save(update: boolean) {
    void act(async () => {
      const checked = nodeTemplateSchema.safeParse(template);
      if (!checked.success)
        throw new Error(
          '이름, 작업 지침, 결과 문서와 필요한 자료(최대 4개)를 확인하세요.',
        );
      const item = shelfEntrySchema.parse(
        await (
          await localRequest('/node-shelf', 'POST', {
            template: checked.data,
            origin: update ? selectedStep.templateOrigin : undefined,
          })
        ).json(),
      );
      await refresh();
      setSearch(item.template.title);
      setFeedback({
        id: item.id,
        text:
          item.template.title + ' · v' + item.version + ' 슬롯에 저장했습니다.',
      });
      setPanel('browse');
    });
  }
  const slotList = entries.filter((n) =>
    (
      n.template.title +
      ' ' +
      (n.template.kind === 'task'
        ? [...n.template.needs, n.template.output].join(' ')
        : '사용자 검토')
    )
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="node-shelf-heading"
      onCancel={close}
    >
      <header>
        <h2 id="node-shelf-heading" ref={heading} tabIndex={-1}>
          {panel === 'save'
            ? 'Save to my nodes'
            : panel === 'custom'
              ? 'New custom node'
              : panel === 'preview'
                ? '흐름 맞춤 미리보기'
                : 'My nodes'}
        </h2>
        <button onClick={close} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      {panel === 'browse' && (
        <>
          <div className={styles.toolbar}>
            <input
              aria-label="내 노드 검색"
              placeholder="이름 또는 문서로 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              disabled={busy}
              onClick={() => {
                setTemplate({
                  kind: 'task',
                  title: '',
                  instructions: '',
                  needs: [],
                  output: '작업 결과',
                });
                setPanel('custom');
                setError('');
              }}
            >
              New custom node
            </button>
          </div>
          <p>{ordered[index]?.title} 뒤에 추가</p>
          {slotList.length === 0 && (
            <p>
              {search
                ? '검색 결과가 없습니다.'
                : '단계 속성에서 자주 쓰는 노드를 저장하세요.'}
            </p>
          )}
          <ul>
            {slotList.map((n) => (
              <li key={n.id}>
                <button
                  aria-label={n.template.title + ' · Toggle favorite'}
                  aria-pressed={n.favorite}
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await localRequest('/node-shelf/' + n.id, 'PATCH', {
                        favorite: !n.favorite,
                      });
                      await refresh();
                    })
                  }
                >
                  <Star size={15} fill={n.favorite ? 'currentColor' : 'none'} />
                </button>
                <button
                  ref={n.id === feedback?.id ? savedSlot : undefined}
                  className={styles.slot}
                  disabled={busy || !ordered.length || ordered.length >= 32}
                  onClick={() => void propose(n.template, n)}
                >
                  <strong>{n.template.title}</strong>
                  <small>
                    v{n.version} ·{' '}
                    {n.template.kind === 'review'
                      ? 'User approval'
                      : n.template.output}
                  </small>
                </button>
                <button
                  disabled={busy}
                  aria-label={n.template.title + ' · Delete from node shelf'}
                  onClick={() => setConfirm(n.id)}
                >
                  <Trash2 size={15} />
                </button>
                {confirm === n.id && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await localRequest(
                          '/node-shelf/' + n.id + '/' + n.version,
                          'DELETE',
                        );
                        setConfirm('');
                        await refresh();
                      })
                    }
                  >
                    Confirm deletion
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {panel === 'save' && preparingLegacy && !error && (
        <p role="status">슬롯의 자료 정보를 불러오는 중…</p>
      )}
      {(panel === 'custom' || (panel === 'save' && !preparingLegacy)) && (
        <>
          <label>
            노드 이름
            <input
              maxLength={100}
              value={template.title}
              onChange={(e) =>
                setTemplate({ ...template, title: e.target.value })
              }
            />
          </label>
          {template.kind === 'task' && (
            <>
              <label>
                재사용할 지침
                <textarea
                  rows={4}
                  maxLength={8000}
                  value={template.instructions}
                  onChange={(e) =>
                    setTemplate({ ...template, instructions: e.target.value })
                  }
                />
              </label>
              <label>
                필요한 자료 · 한 줄에 하나
                <textarea
                  rows={2}
                  value={template.needs.join('\n')}
                  onChange={(e) =>
                    setTemplate({
                      ...template,
                      needs: e.target.value ? e.target.value.split('\n') : [],
                    })
                  }
                />
              </label>
              <label>
                결과 문서
                <input
                  maxLength={100}
                  value={template.output}
                  onChange={(e) =>
                    setTemplate({ ...template, output: e.target.value })
                  }
                />
              </label>
            </>
          )}
          {panel === 'save' ? (
            <footer>
              {selectedStep.templateOrigin && (
                <button disabled={busy} onClick={() => save(true)}>
                  Update existing slot
                </button>
              )}
              <button disabled={busy} onClick={() => save(false)}>
                {selectedStep.templateOrigin
                  ? 'Save to a new slot'
                  : 'Save to slot'}
              </button>
            </footer>
          ) : (
            <footer>
              <button disabled={busy} onClick={() => void propose(template)}>
                Adapt to workflow
              </button>
            </footer>
          )}
        </>
      )}
      {panel === 'preview' && (
        <>
          <div className={styles.wire}>
            {ordered[index]?.title} → <strong>{template.title}</strong>
            {next ? ' → ' + next.title : ''}
          </div>
          {fit && template.kind === 'task' ? (
            <>
              <p>{fit.reason}</p>
              <details>
                <summary>Original instructions</summary>
                <p>{template.instructions}</p>
              </details>
              <label>
                적용할 지침
                <textarea
                  rows={5}
                  maxLength={8000}
                  value={fit.instructions}
                  onChange={(e) =>
                    setFit({ ...fit, instructions: e.target.value })
                  }
                />
              </label>
              {template.needs.map((name, i) => (
                <label key={i}>
                  {name}
                  <select
                    value={fit.sources[i] ?? ''}
                    onChange={(e) =>
                      setFit({
                        ...fit,
                        sources: fit.sources.map((v, j) =>
                          i === j ? e.target.value || null : v,
                        ),
                      })
                    }
                  >
                    <option value="">자료 연결 필요</option>
                    <option value="@source">이번 실행의 원본 자료</option>
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {writer && (
                <label className={styles.check}>
                  <input
                    type="checkbox"
                    checked={pass}
                    disabled={!canPass}
                    onChange={(e) => setPass(e.target.checked)}
                  />
                  {writer.title}에 결과 전달
                  {!canPass ? ' · 기존 입력 4개 사용 중' : ''}
                </label>
              )}
              {next?.kind === 'review' && (
                <p>{next.title}에서 이 노드의 결과를 승인합니다.</p>
              )}
            </>
          ) : (
            <p>이 위치에서 실행이 멈추고 사용자의 검토를 기다립니다.</p>
          )}
          <footer>
            <button onClick={close}>Cancel</button>
            <button
              disabled={
                busy ||
                (!!fit &&
                  (!fit.instructions.trim() || fit.sources.includes(null)))
              }
              onClick={() => {
                try {
                  const id = 'step-' + crypto.randomUUID();
                  apply(
                    insertFittedNode(
                      definition,
                      after,
                      template,
                      fit,
                      id,
                      pass,
                      origin && { id: origin.id, version: origin.version },
                    ),
                    id,
                  );
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : '연결을 확인하세요.',
                  );
                }
              }}
            >
              Apply to wire
            </button>
          </footer>
        </>
      )}
      <div role="status" aria-live="polite">
        {panel === 'browse' && !busy ? feedback?.text : ''}
      </div>
      {busy && (
        <p role="status">
          {panel === 'custom' || panel === 'browse' ? 'Processing…' : 'Saving…'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </dialog>
  );
}
