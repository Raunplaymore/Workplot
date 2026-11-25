import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  resultPromptOriginSchema,
  workflowVersionSchema,
  type ResultPromptOrigin,
  type WorkflowDefinition,
  type WorkflowVersion,
} from '@studio/contracts';
import { localRequest } from './local-request';
import dialogStyles from './DesignDocument.module.css';
import styles from './WorkflowStudio.module.css';
import comparisonStyles from './RunPromptComparison.module.css';

type Task = Extract<WorkflowDefinition['steps'][number], { kind: 'task' }>;

function SavedPrompt({
  workflowId,
  stepId,
}: {
  workflowId: string;
  stepId: string;
}) {
  const [saved, setSaved] = useState<WorkflowVersion | null>();
  useEffect(() => {
    const controller = new AbortController();
    void localRequest(
      '/workflows/' + workflowId,
      'GET',
      undefined,
      controller.signal,
    )
      .then((response) => response.json())
      .then((value: unknown) => workflowVersionSchema.parse(value))
      .then((record) => {
        if (!controller.signal.aborted) setSaved(record);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSaved(null);
      });
    return () => controller.abort();
  }, [workflowId]);

  const task = saved?.definition.steps.find((step) => step.id === stepId);
  return (
    <section>
      <h3>Saved Prompt{saved && ' · v' + saved.version}</h3>
      {task?.kind === 'task' && !task.workflowRef ? (
        <pre>{task.instructions}</pre>
      ) : (
        <p role="status">
          {saved === undefined
            ? '최신 저장본을 불러오는 중…'
            : saved === null
              ? '최신 저장본을 읽을 수 없습니다.'
              : '최신 저장본에서 이 노드의 프롬프트를 찾을 수 없습니다.'}
        </p>
      )}
    </section>
  );
}

export function RunPromptComparison({
  workflowId,
  runId,
  runVersion,
  sourceKind,
  step,
  file,
  result,
}: {
  workflowId: string;
  runId: string;
  runVersion: number;
  sourceKind: 'direct' | 'inherited' | 'linked';
  step: Task;
  file: string;
  result: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState<ResultPromptOrigin | null>();
  useEffect(() => {
    if (!open || sourceKind === 'direct') return;
    const controller = new AbortController();
    void localRequest(
      '/runs/' +
        runId +
        '/results/' +
        encodeURIComponent(file) +
        '/prompt-origin',
      'GET',
      undefined,
      controller.signal,
    )
      .then((response) => response.json())
      .then((value: unknown) => resultPromptOriginSchema.parse(value))
      .then((value) => {
        if (!controller.signal.aborted) setOrigin(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setOrigin(null);
      });
    return () => controller.abort();
  }, [open, sourceKind, runId, file]);

  const source: ResultPromptOrigin | null | undefined =
    sourceKind !== 'direct'
      ? origin
      : {
          runId,
          version: runVersion,
          stepId: step.id,
          instructions: step.instructions,
        };
  function close() {
    dialog.current?.close();
    setOpen(false);
    setOrigin(undefined);
    trigger.current?.focus();
  }
  return (
    <>
      <button
        type="button"
        ref={trigger}
        className={styles.compareLink}
        aria-haspopup="dialog"
        onClick={() => {
          dialog.current?.showModal();
          setOpen(true);
        }}
      >
        Compare
      </button>
      {createPortal(
        <dialog
          ref={dialog}
          className={dialogStyles.dialog}
          aria-labelledby={heading}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <header>
            <h2 id={heading}>Compare</h2>
            <button
              type="button"
              className={styles.compareLink}
              autoFocus
              onClick={close}
            >
              Close
            </button>
          </header>
          {open && (
            <div
              className={comparisonStyles.reader}
              role="region"
              aria-label={step.title + ' · ' + file}
              tabIndex={0}
            >
              <div className={comparisonStyles.prompts}>
                <section>
                  <h3>Run Prompt{source && ' · v' + source.version}</h3>
                  {source ? (
                    <pre>{source.instructions}</pre>
                  ) : (
                    <p role="status">
                      {source === null
                        ? '생성 실행의 프롬프트를 확인할 수 없습니다.'
                        : '생성 실행의 프롬프트를 불러오는 중…'}
                    </p>
                  )}
                </section>
                {(source || sourceKind !== 'linked') && (
                  <SavedPrompt
                    workflowId={source?.workflowId ?? workflowId}
                    stepId={source?.stepId ?? step.id}
                  />
                )}
              </div>
              <section className={comparisonStyles.result}>
                <h3>Result · {file}</h3>
                {(source || sourceKind === 'inherited') && (
                  <details className={comparisonStyles.source}>
                    <summary>Source</summary>
                    <dl>
                      {(sourceKind === 'inherited' ||
                        (source && source.runId !== runId)) && (
                        <>
                          <dt>Current Run</dt>
                          <dd>{runId}</dd>
                        </>
                      )}
                      {source && (
                        <>
                          <dt>Origin Run</dt>
                          <dd>{source.runId}</dd>
                          <dt>Origin Node</dt>
                          <dd>{source.stepId}</dd>
                        </>
                      )}
                    </dl>
                  </details>
                )}
                <pre>{result}</pre>
              </section>
            </div>
          )}
        </dialog>,
        document.body,
      )}
    </>
  );
}
