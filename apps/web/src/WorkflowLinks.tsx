import { useContext, useEffect, useState } from 'react';
import {
  linkCandidateSchema,
  linkUsageSchema,
  linkWorkflowStep,
  type LinkCandidate,
  type LinkUsage,
  type WorkflowDefinition,
} from '@studio/contracts';
import { localRequest } from './local-request';
import { ConnectionsOpen } from './StepProperties';

type Task = Extract<WorkflowDefinition['steps'][number], { kind: 'task' }>;
export function WorkflowLinkPicker({
  parent,
  draft,
  step,
  pinnedName,
  change,
}: {
  parent: string | null;
  draft: WorkflowDefinition;
  step: Task;
  pinnedName?: string;
  change: (s: Task) => void;
}) {
  const open = useContext(ConnectionsOpen);
  const [attempt, retry] = useState(0);
  const payload = open ? JSON.stringify({ parent, step: step.id, draft }) : '';
  const [state, setState] = useState<{
    payload: string;
    options: LinkCandidate[];
    error?: string;
  }>();
  useEffect(() => {
    if (!payload) return;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        void localRequest(
          '/workflow-links/candidates',
          'POST',
          JSON.parse(payload),
          controller.signal,
        )
          .then((r) => r.json())
          .then((data) => {
            if (!controller.signal.aborted)
              setState({
                payload,
                options: linkCandidateSchema.array().parse(data),
              });
          })
          .catch((e: Error) => {
            if (!controller.signal.aborted)
              setState({ payload, options: [], error: e.message });
          }),
      100,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [payload, attempt]);
  const current = state?.payload === payload ? state : undefined;
  const ref = step.workflowRef;
  const options = current?.options ?? [];
  return (
    <>
      <label>
        연결할 워크플롯
        <select
          value={ref ? ref.id + '/' + ref.version : ''}
          disabled={!current && !ref}
          onChange={(e) => {
            if (!e.target.value) {
              change({ ...step, workflowRef: undefined });
              return;
            }
            const row = options.find(
              (item) => item.id + '/' + item.version === e.target.value,
            );
            if (row && !row.reason) change(linkWorkflowStep(step, row));
          }}
        >
          <option value="">연결 없음</option>
          {ref &&
            !options.some(
              (row) => row.id === ref.id && row.version === ref.version,
            ) && (
              <option value={ref.id + '/' + ref.version}>
                {pinnedName ?? '연결된 흐름'} · v{ref.version}
              </option>
            )}
          {options.map((row) => (
            <option
              key={row.id}
              disabled={!!row.reason}
              value={row.id + '/' + row.version}
            >
              {row.name} · v{row.version}
              {row.reason ? ' — ' + row.reason : ''}
            </option>
          ))}
        </select>
      </label>
      {current?.error && (
        <p role="alert">
          {current.error}{' '}
          <button type="button" onClick={() => retry((n) => n + 1)}>
            Retry connections
          </button>
        </p>
      )}
    </>
  );
}

export function WorkflowUsage({ id }: { id: string }) {
  const [items, setItems] = useState<LinkUsage[]>();
  const [error, setError] = useState('');
  const [attempt, retry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setItems(undefined);
    setError('');
    void localRequest(
      '/workflows/' + id + '/used-by',
      'GET',
      undefined,
      controller.signal,
    )
      .then((r) => r.json())
      .then((data) => {
        if (!controller.signal.aborted)
          setItems(linkUsageSchema.array().parse(data));
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [id, attempt]);
  if (error)
    return (
      <p role="alert">
        {error}{' '}
        <button type="button" onClick={() => retry((n) => n + 1)}>
          Retry usage
        </button>
      </p>
    );
  if (!items?.length) return null;
  return (
    <section aria-label="Used by">
      <h3>Used by</h3>
      <ul>
        {items.map((row, i) => (
          <li key={row.id + '/' + i}>
            <a href={'#/library/' + row.id}>
              {row.name} · v{row.version}
            </a>
            {' › ' + row.step + ' · pinned v' + row.pinned}
            {row.location !== 'active' ? ' · ' + row.location : ''}
          </li>
        ))}
      </ul>
    </section>
  );
}
