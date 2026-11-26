import { useRef, useState, useMemo } from 'react';
import { diffArrays, diffWordsWithSpace } from 'diff';
import type { DocumentSource } from './document-source';
import styles from './DesignDocument.module.css';

type Row = {
  before?: string;
  after?: string;
  kind: '유지' | '추가' | '삭제' | '수정';
};

function lines(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
}

export function documentRows(before: string, after: string) {
  const parts = diffArrays(lines(before), lines(after), { timeout: 150 });
  if (!parts) return null;
  const rows: Row[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      for (const line of part.value)
        rows.push({ before: line, after: line, kind: '유지' });
      continue;
    }
    const old = part.removed ? part.value : [];
    const added = part.added
      ? part.value
      : parts[i + 1]?.added
        ? parts[++i]!.value
        : [];
    for (let j = 0; j < Math.max(old.length, added.length); j++) {
      rows.push({
        before: old[j],
        after: added[j],
        kind: j >= old.length ? '추가' : j >= added.length ? '삭제' : '수정',
      });
    }
  }
  return rows;
}

export function DocumentChanges({
  before,
  after,
  previous,
  current,
}: {
  before: string;
  after: string;
  previous: DocumentSource;
  current: DocumentSource;
}) {
  const rows = useMemo(() => documentRows(before, after), [before, after]);
  const [onlyChanges, setOnlyChanges] = useState(false);
  const table = useRef<HTMLTableElement>(null);
  const [changeIndex, setChangeIndex] = useState(-1);
  function visitChange(offset: number) {
    const changes = table.current?.querySelectorAll<HTMLElement>(
      'tr[data-changed="true"]',
    );
    if (!changes?.length) return;
    const index = Math.max(
      0,
      Math.min(changes.length - 1, changeIndex + offset),
    );
    setChangeIndex(index);
    changes[index]?.focus();
  }
  const counts = { 추가: 0, 삭제: 0, 수정: 0 };
  for (const row of rows ?? []) if (row.kind !== '유지') counts[row.kind]++;
  return (
    <>
      <p role="status">
        {!rows
          ? '변경 줄 계산 시간이 길어 두 원문을 표시합니다.'
          : counts.추가 + counts.삭제 + counts.수정 === 0
            ? '두 회차의 내용이 같습니다.'
            : '추가 ' +
              counts.추가 +
              '줄 · 수정 ' +
              counts.수정 +
              '줄 · 삭제 ' +
              counts.삭제 +
              '줄'}
      </p>
      {rows?.some((row) => row.kind !== '유지') && (
        <button
          aria-pressed={onlyChanges}
          onClick={() => setOnlyChanges(!onlyChanges)}
        >
          {onlyChanges ? 'Show all lines' : 'Show changes only'}
        </button>
      )}
      {rows?.some((row) => row.kind !== '유지') && (
        <div>
          <button disabled={changeIndex <= 0} onClick={() => visitChange(-1)}>
            Previous change
          </button>
          <button
            disabled={
              changeIndex >= counts.추가 + counts.삭제 + counts.수정 - 1
            }
            onClick={() => visitChange(1)}
          >
            Next change
          </button>
        </div>
      )}
      <table
        ref={table}
        className={styles.comparison}
        aria-label="회차별 문서 변경"
      >
        <thead>
          <tr>
            <th>직전 · {previous.runNumber}회차</th>
            <th>선택 · {current.runNumber}회차</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? [{ before, after, kind: '유지' } as Row]).map(
            (row, index) => {
              if (onlyChanges && row.kind === '유지') return null;
              const words =
                row.kind === '수정'
                  ? diffWordsWithSpace(row.before!, row.after!, { timeout: 15 })
                  : undefined;
              return (
                <tr
                  key={index}
                  data-changed={row.kind !== '유지'}
                  tabIndex={row.kind === '유지' ? undefined : -1}
                >
                  <td
                    data-change={
                      row.before !== undefined && row.kind !== '유지'
                        ? 'old'
                        : undefined
                    }
                  >
                    {row.before !== undefined && row.kind !== '유지' && (
                      <b>{row.kind === '삭제' ? '− 삭제' : '수정 전'}</b>
                    )}
                    {words
                      ? words.map((w, i) =>
                          w.added ? null : w.removed ? (
                            <del key={i}>{w.value}</del>
                          ) : (
                            w.value
                          ),
                        )
                      : row.before}
                  </td>
                  <td
                    data-change={
                      row.after !== undefined && row.kind !== '유지'
                        ? 'new'
                        : undefined
                    }
                  >
                    {row.after !== undefined && row.kind !== '유지' && (
                      <b>{row.kind === '추가' ? '+ 추가' : '수정 후'}</b>
                    )}
                    {words
                      ? words.map((w, i) =>
                          w.removed ? null : w.added ? (
                            <ins key={i}>{w.value}</ins>
                          ) : (
                            w.value
                          ),
                        )
                      : row.after}
                  </td>
                </tr>
              );
            },
          )}
        </tbody>
      </table>
    </>
  );
}
