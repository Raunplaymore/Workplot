import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Upload } from 'lucide-react';
import {
  orderedSteps,
  workflowVersionSchema,
  type WorkflowPackage,
  requiredInputFields,
  writableStep,
  type WorkflowVersion,
} from '@studio/contracts';
import { localRequest, LocalRequestError } from './local-request';
import styles from './WorkflowPackage.module.css';

type Reference = { id: string; version: number };
type Preview = {
  localVersion: number | null;
  modified: boolean;
  installed: boolean;
  changes: string[];
  revision: string;
};
type Origin = Reference & { localVersion: number; modified: boolean };

export async function downloadWorkflow(flow: {
  id: string;
  version: number;
  name: string;
}) {
  const response = await localRequest(
    '/workflows/' + flow.id + '/versions/' + flow.version + '/package',
  );
  const bundle = await response.json();
  const link = document.createElement('a');
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(bundle, null, 2) + '\n'], {
      type: 'application/json',
    }),
  );
  link.href = url;
  link.download =
    (flow.name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'workflow') +
    '-v' +
    flow.version +
    '.workplot.json';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function WorkflowOrigin({ flow }: { flow: WorkflowVersion }) {
  const [origin, setOrigin] = useState<Origin | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void localRequest(
      '/workflows/' + flow.id + '/package-origin',
      'GET',
      undefined,
      controller.signal,
    )
      .then((r) => r.json())
      .then((data) => {
        if (!controller.signal.aborted && typeof data?.id === 'string')
          setOrigin(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [flow.id, flow.version]);
  return (
    origin && (
      <small title={origin.id}>
        Imported from v{origin.version} ·{' '}
        {origin.modified ? 'Locally modified' : 'Matches imported version'}
      </small>
    )
  );
}

export function WorkflowImport({
  imported,
}: {
  imported: (flow: WorkflowVersion) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  return (
    <>
      <button
        className={styles.trigger}
        type="button"
        onClick={() => input.current?.click()}
      >
        <Upload size={16} aria-hidden="true" /> Import workflow…
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept=".json,application/json"
        aria-label="Workflow package"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      {file && (
        <ImportDialog
          file={file}
          close={() => setFile(null)}
          imported={imported}
        />
      )}
    </>
  );
}

function ImportDialog({
  file,
  close,
  imported,
}: {
  file: File;
  close: () => void;
  imported: (flow: WorkflowVersion) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<{
    bundle: WorkflowPackage;
    preview: Preview;
  } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    void (async () => {
      if (file.size > 32 * 1024 * 1024)
        throw new Error('32MB 이하의 워크플롯 파일을 선택하세요.');
      let bundle: WorkflowPackage;
      try {
        bundle = JSON.parse(await file.text());
      } catch {
        throw new Error('올바른 JSON 파일을 선택하세요.');
      }
      const response = await localRequest(
        '/workflow-packages/preview',
        'POST',
        { bundle },
        controller.signal,
      );
      const preview: Preview = await response.json();
      if (!controller.signal.aborted) setData({ bundle, preview });
    })().catch((e: unknown) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '파일을 읽지 못했습니다.');
    });
    return () => controller.abort();
  }, [file, attempt]);
  async function confirm() {
    if (!data || saving) return;
    setSaving(true);
    setError('');
    try {
      const { bundle, preview } = data;
      const response = await localRequest('/workflow-packages/import', 'POST', {
        bundle,
        expectedLocalVersion: preview.localVersion,
        revision: preview.revision,
      });
      const version = workflowVersionSchema.parse(await response.json());
      await imported(version);
      close();
    } catch (e) {
      if (e instanceof LocalRequestError && e.status === 409) setData(null);
      setError(e instanceof Error ? e.message : '가져오지 못했습니다.');
    } finally {
      setSaving(false);
    }
  }
  const root = data?.bundle.workflows.find(
    (w) =>
      w.id === data.bundle.root.id && w.version === data.bundle.root.version,
  );
  const runtime = root
    ? orderedSteps(root.definition).flatMap((step) => {
        if (step.kind !== 'task' || !step.workflowRef) return [step];
        const ref = step.workflowRef;
        const child = data?.bundle.workflows.find(
          (w) => w.id === ref.id && w.version === ref.version,
        );
        return child ? orderedSteps(child.definition) : [];
      })
    : [];
  return createPortal(
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-label="Import workflow"
      onCancel={(e) => {
        e.preventDefault();
        if (!saving) close();
      }}
    >
      <header>
        <h2>Import workflow</h2>
        <button type="button" disabled={saving} onClick={close}>
          Close
        </button>
      </header>
      <div className={styles.content}>
        <small>{file.name}</small>
        {error && <p role="alert">{error}</p>}
        {!data && !error && <p role="status">Reading package…</p>}
        {data && root && (
          <>
            <h3>
              {root.definition.name} · v{root.version}
            </h3>
            {root.definition.goal && <p>{root.definition.goal}</p>}
            <p>
              {data.bundle.workflows.length}개 워크플롯 ·{' '}
              {data.preview.localVersion === null
                ? '새로 가져오기'
                : data.preview.installed
                  ? '이미 설치된 버전'
                  : '현재 로컬 v' + data.preview.localVersion + ' 업데이트'}
            </p>
            {data.preview.modified && (
              <p role="status">
                {data.preview.installed
                  ? '현재 로컬 수정본을 엽니다.'
                  : '로컬 수정이 있습니다. 변경 목록을 확인한 뒤 업데이트하세요.'}
              </p>
            )}
            {data.preview.changes.length > 0 && (
              <section aria-label="Changes">
                <h4>Changes</h4>
                <ul>
                  {data.preview.changes.map((change, i) => (
                    <li key={i}>{change}</li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h4>Included workflows</h4>
              {data.bundle.workflows.map((w) => {
                const steps = orderedSteps(w.definition);
                const fields = requiredInputFields(w.definition);
                const capabilities = new Set<string>();
                for (const s of steps)
                  if (s.kind === 'task') {
                    if (!s.workflowRef)
                      capabilities.add(
                        s.agent === 'unassigned' ? 'Unassigned agent' : 'Codex',
                      );
                    if (s.tool) capabilities.add(s.tool);
                    if (s.codexSkill) capabilities.add(s.codexSkill.title);
                    if (s.skill && s.skill !== 'none')
                      capabilities.add(s.skill);
                    if (!s.workflowRef)
                      capabilities.add(
                        writableStep(s, runtime)
                          ? 'Workspace write'
                          : 'Read only',
                      );
                  }
                return (
                  <div className={styles.flow} key={w.id + '/' + w.version}>
                    <strong>
                      {w.definition.name} · v{w.version}
                    </strong>
                    <ol>
                      {steps.map((s) => (
                        <li key={s.id}>
                          {s.title}
                          {s.kind === 'review' && ' · Approval'}
                        </li>
                      ))}
                    </ol>
                    {capabilities.size > 0 && (
                      <small>
                        Tools &amp; access · {[...capabilities].join(' · ')}
                      </small>
                    )}
                    <details>
                      <summary>Inspect prompts</summary>
                      {steps.map(
                        (s) =>
                          s.kind === 'task' && (
                            <section key={s.id}>
                              <strong>{s.title}</strong>
                              <pre>{s.instructions}</pre>
                            </section>
                          ),
                      )}
                    </details>
                    {fields.length > 0 && (
                      <small>Required input · {fields.join(', ')}</small>
                    )}
                  </div>
                );
              })}
            </section>
            <p>
              개발 작업에 사용할 프로젝트 폴더는 가져온 뒤 이 Mac에서
              연결하세요.
            </p>
          </>
        )}
      </div>
      <footer>
        {error && !data ? (
          <button type="button" onClick={() => retry((n) => n + 1)}>
            Check again
          </button>
        ) : (
          <button
            type="button"
            disabled={!data || saving}
            onClick={() => void confirm()}
          >
            <Download size={16} aria-hidden="true" />
            {saving
              ? 'Importing…'
              : data?.preview.installed
                ? 'Open installed workflow'
                : data?.preview.localVersion != null
                  ? 'Update workflow'
                  : 'Import workflow'}
          </button>
        )}
      </footer>
    </dialog>,
    document.body,
  );
}
