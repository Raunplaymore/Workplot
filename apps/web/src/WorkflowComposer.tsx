import { ArrowUp, MessageSquareText, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import {
  designSkillsSchema,
  designSkillSchema,
  type DesignSkill,
  type WorkflowDefinition,
} from '@studio/contracts';
import { workflowSuggestion } from './workflow-suggestion';
import { localRequest } from './local-request';
import styles from './WorkflowStudio.module.css';

export function WorkflowComposer({
  base,
  disabled,
  value,
  change,
  skill,
  selectSkill,
  submit,
}: {
  base: WorkflowDefinition;
  disabled: boolean;
  value: string;
  change: (text: string) => void;
  skill: DesignSkill | null;
  selectSkill: (skill: DesignSkill | null) => void;
  submit: (text: string) => void;
}) {
  const selection = useRef<AbortController | null>(null);
  useEffect(() => () => selection.current?.abort(), []);
  const field = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const [caret, setCaret] = useState(0),
    [dismissed, dismiss] = useState(false);
  const [catalog, setCatalog] = useState<ReturnType<
      typeof designSkillsSchema.parse
    > | null>(null),
    [error, setError] = useState('');
  const [index, highlight] = useState(0);
  const mention = /(?:^|\s)\$([\p{L}\p{M}\p{N}_:-]*)$/u.exec(
    value.slice(0, caret),
  );
  const open = !!mention && !dismissed;
  const query = mention?.[1]?.toLocaleLowerCase() ?? '';
  const options = (catalog ?? []).filter((s) =>
    (s.title + ' ' + s.description).toLocaleLowerCase().includes(query),
  );
  const current = Math.min(index, options.length - 1);
  useEffect(() => {
    if (open && current >= 0)
      document
        .getElementById(listId + '-' + current)
        ?.scrollIntoView({ block: 'nearest' });
  }, [open, current, query, listId]);
  useEffect(() => {
    if (!open) return;
    const c = new AbortController();
    void localRequest('/design-skills', 'GET', undefined, c.signal)
      .then((r) => r.json())
      .then((data) => {
        if (!c.signal.aborted) {
          setCatalog(designSkillsSchema.parse(data));
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (!c.signal.aborted)
          setError(
            e instanceof Error ? e.message : '스킬을 불러오지 못했습니다.',
          );
      });
    return () => c.abort();
  }, [open]);
  async function pick(item: Pick<DesignSkill, 'id'>) {
    if (!mention) return;
    selection.current?.abort();
    const controller = new AbortController();
    selection.current = controller;
    let details: DesignSkill;
    try {
      const response = await localRequest(
        '/design-skills/' + item.id,
        'GET',
        undefined,
        controller.signal,
      );
      details = designSkillSchema.parse(await response.json());
      if (controller.signal.aborted) return;
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '스킬을 읽지 못했습니다.');
      return;
    }
    const start = caret - query.length - 1;
    const suffix = value.slice(caret).replace(/^[\p{L}\p{M}\p{N}_:-]*/u, '');
    change(value.slice(0, start) + suffix);
    selectSkill(details);
    dismiss(true);
    highlight(0);
    setCaret(start);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(start, start);
    });
  }
  const suggestion =
    !disabled && !value.trim() && !skill ? workflowSuggestion(base) : undefined;
  const instruction =
    value.trim() || (skill ? '$' + skill.title + ' 써줘' : '');
  return (
    <form
      className={styles.composer}
      aria-label="말로 흐름 수정"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          selection.current?.abort();
          dismiss(true);
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && !open && instruction) submit(instruction);
      }}
    >
      {skill && (
        <div className={styles.skillChip}>
          <details key={skill.id}>
            <summary>{skill.title}</summary>
            <p>{skill.instructions}</p>
          </details>
          <button
            type="button"
            aria-label={skill.title + ' 스킬 해제'}
            onClick={() => {
              selectSkill(null);
              field.current?.focus();
            }}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <div className={styles.composerEntry}>
        <label>
          <span>
            <MessageSquareText size={17} aria-hidden="true" /> 말로 흐름 수정
          </span>
          <textarea
            aria-label="변경 요청"
            ref={field}
            rows={2}
            maxLength={2000}
            value={value}
            placeholder="바꾸고 싶은 내용 입력 · $로 Codex 스킬 찾기"
            aria-autocomplete="list"
            aria-controls={open ? listId : undefined}
            aria-activedescendant={
              open && current >= 0 ? listId + '-' + current : undefined
            }
            onSelect={(e) => {
              setCaret(e.currentTarget.selectionStart);
            }}
            onChange={(e) => {
              selection.current?.abort();
              change(e.target.value);
              setCaret(e.target.selectionStart);
              dismiss(false);
              highlight(0);
            }}
            onKeyDown={(e) => {
              if (
                !open ||
                e.nativeEvent.isComposing ||
                e.nativeEvent.keyCode === 229
              )
                return;
              if (e.key === 'Escape') {
                selection.current?.abort();
                e.preventDefault();
                dismiss(true);
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (options.length)
                  highlight(
                    (current +
                      (e.key === 'ArrowDown' ? 1 : -1) +
                      options.length) %
                      options.length,
                  );
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!error && options[current]) void pick(options[current]);
              }
            }}
          />
        </label>
        <button
          className={styles.primary}
          type="submit"
          disabled={disabled || open || !instruction}
          title="변경안 만들기"
          aria-label="변경안 만들기"
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
        {open && (
          <div className={styles.skillMenu}>
            <div role="listbox" aria-label="Codex 스킬" id={listId}>
              {!error &&
                options.map((s, i) => (
                  <button
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={current === i}
                    id={listId + '-' + i}
                    key={s.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(s)}
                  >
                    <strong>${s.title}</strong>
                    <small>{s.description}</small>
                  </button>
                ))}
            </div>
            {(error || !options.length) && (
              <small role="status">
                {error ||
                  (catalog === null
                    ? '스킬을 불러오는 중입니다.'
                    : catalog.length
                      ? '일치하는 스킬이 없습니다.'
                      : '활성화된 Codex 스킬이 없습니다.')}
              </small>
            )}
          </div>
        )}
      </div>
      {suggestion && (
        <button
          type="button"
          className={styles.suggestion}
          onClick={() => submit(suggestion)}
        >
          [Quick response] {suggestion}
        </button>
      )}
    </form>
  );
}
