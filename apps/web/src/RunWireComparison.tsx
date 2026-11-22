import { useCallback, useEffect, useState } from 'react';
import {
  workflowPlan,
  workflowVersionSchema,
  type WorkflowVersion,
} from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './WorkflowStudio.module.css';

export function useSavedVersion(id?: string) {
  const [saved, setSaved] = useState<WorkflowVersion | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    localRequest('/workflows/' + id, 'GET', undefined, controller.signal)
      .then((response) => response.json())
      .then((value) => workflowVersionSchema.parse(value))
      .then((value) => {
        if (!controller.signal.aborted) setSaved(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSaved(null);
      });
    return () => controller.abort();
  }, [id, refreshKey]);
  useEffect(() => {
    if (!id) return;
    const whenVisible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener('focus', whenVisible);
    const timer = window.setInterval(whenVisible, 15000);
    return () => {
      window.removeEventListener('focus', whenVisible);
      window.clearInterval(timer);
    };
  }, [id, refresh]);
  return { saved: saved?.id === id ? saved : null, refresh };
}

function Wire({ version, label }: { version: WorkflowVersion; label: string }) {
  const { steps } = workflowPlan(version.definition);
  return (
    <section aria-label={label}>
      <strong>
        {label} v{version.version}
      </strong>
      <ol className={styles.sequence}>
        {steps.map((step) => (
          <li key={step.id}>
            {step.title}
            {step.kind === 'review' ? ' · 승인' : ''}
            {step.inputs.length > 0 && (
              <small className={styles.wireInput}>
                입력 · {step.inputs.map((id) => id + '.md').join(', ')}
              </small>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
export function RunWireComparison({
  record,
  saved,
  refresh,
}: {
  record: WorkflowVersion;
  saved: WorkflowVersion | null;
  refresh: () => void;
}) {
  const changed = saved && saved.version !== record.version;
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open) refresh();
      }}
    >
      <summary>
        와이어 비교 · 실행 v{record.version}
        {saved ? ' / 저장 v' + saved.version : ''}
      </summary>
      <p>
        {saved
          ? changed
            ? '이 실행은 시작 당시의 와이어와 입력을 유지합니다. 저장본 변경은 새 실행부터 적용됩니다.'
            : '실행본과 최신 저장본의 버전이 같습니다.'
          : '최신 저장본을 확인할 수 없습니다.'}
      </p>
      <div className={styles.wireComparison}>
        <Wire version={record} label="실행 당시" />
        {changed && <Wire version={saved} label="최신 저장본" />}
      </div>
    </details>
  );
}
