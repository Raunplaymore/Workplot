import { useState } from 'react';

function parseTags(text: string) {
  return [
    ...new Set(
      text
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

export function WorkflowClassification({
  project,
  tags,
  update,
}: {
  project: string | undefined;
  tags: string[] | undefined;
  update: (value: { project?: string; tags?: string[] }) => void;
}) {
  const [typed, setTyped] = useState(tags?.join(', ') ?? '');
  const savedTags = tags ?? [];
  // Keep the user's trailing comma while typing, and follow undo or draft replacement.
  const text =
    JSON.stringify(parseTags(typed)) === JSON.stringify(savedTags)
      ? typed
      : savedTags.join(', ');
  const invalid =
    savedTags.length > 12 || savedTags.some((tag) => tag.length > 40);
  return (
    <>
      <label>
        Project
        <input
          value={project ?? ''}
          maxLength={100}
          onChange={(e) => update({ project: e.target.value || undefined })}
          onBlur={(e) => {
            if (e.target.value !== e.target.value.trim())
              update({ project: e.target.value.trim() || undefined });
          }}
        />
      </label>
      <label>
        Tags
        <input
          value={text}
          placeholder="Comma-separated tags"
          aria-invalid={invalid}
          maxLength={600}
          onChange={(e) => {
            setTyped(e.target.value);
            const next = parseTags(e.target.value);
            if (JSON.stringify(next) !== JSON.stringify(savedTags))
              update({ tags: next.length ? next : undefined });
          }}
          onBlur={() => setTyped(savedTags.join(', '))}
        />
      </label>
      {invalid && (
        <small role="alert">태그는 최대 12개, 각 40자까지 입력하세요.</small>
      )}
    </>
  );
}
