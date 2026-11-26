import { useState } from 'react';
import {
  orderedSteps,
  type WorkflowDefinition,
  type WorkflowVersion,
} from '@studio/contracts';
import { MarkdownDocument } from './MarkdownDocument';
export function LinkedInstructions({
  record,
  disabled,
  save,
}: {
  record: WorkflowVersion;
  disabled: boolean;
  save: (definition: WorkflowDefinition) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const steps = orderedSteps(record.definition);
  const changed = steps.some(
    (s) =>
      s.kind === 'task' &&
      values[s.id] !== undefined &&
      values[s.id] !== s.instructions,
  );
  return (
    <>
      <ol>
        {steps.map((s) => (
          <li key={s.id}>
            <strong>{s.title}</strong>
            {s.kind === 'task' &&
              (editing ? (
                <label>
                  {s.title} 지침
                  <textarea
                    aria-label={s.title + ' 지침'}
                    maxLength={8000}
                    rows={4}
                    value={values[s.id] ?? s.instructions}
                    onChange={(e) =>
                      setValues({ ...values, [s.id]: e.target.value })
                    }
                  />
                </label>
              ) : (
                <MarkdownDocument text={s.instructions} />
              ))}
          </li>
        ))}
      </ol>
      {editing ? (
        <>
          <p>
            저장하면 하위 지침과 현재 흐름의 변경 사항이 함께 새 버전으로
            저장됩니다.
          </p>
          <button
            type="button"
            disabled={
              disabled ||
              !changed ||
              Object.values(values).some((v) => !v.trim())
            }
            onClick={() =>
              save({
                ...record.definition,
                steps: record.definition.steps.map((s) =>
                  s.kind === 'task'
                    ? { ...s, instructions: values[s.id] ?? s.instructions }
                    : s,
                ),
              })
            }
          >
            Save
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setValues({});
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          Edit child instructions
        </button>
      )}
    </>
  );
}
