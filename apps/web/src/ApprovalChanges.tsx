import { useState } from 'react';
import { documentRows } from './DocumentChanges';
import { localRequest } from './local-request';

export function ApprovalChanges({ run, file }: { run: string; file: string }) {
  const [history, setHistory] = useState<{
    original: string;
    edits: { text: string; at: string }[];
  }>();
  const [error, setError] = useState('');
  return (
    <details
      onToggle={async (e) => {
        if (!e.currentTarget.open || history) return;
        try {
          setHistory(
            await (
              await localRequest(
                '/runs/' +
                  run +
                  '/results/' +
                  encodeURIComponent(file) +
                  '/reviews',
              )
            ).json(),
          );
          setError('');
        } catch {
          setError('수정 이력을 불러오지 못했습니다. 다시 펼쳐 확인하세요.');
        }
      }}
    >
      <summary>승인 시 수정한 내용</summary>
      {error && <p role="alert">{error}</p>}
      {history?.edits.map((edit, i) => {
        const before = i ? history.edits[i - 1]!.text : history.original;
        const rows = documentRows(before, edit.text);
        return (
          <section key={i}>
            <strong>{new Date(edit.at).toLocaleString('ko-KR')}</strong>
            <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {rows
                ? rows
                    .filter((r) => r.kind !== '유지')
                    .flatMap((r) => [
                      ...(r.before !== undefined ? ['− ' + r.before] : []),
                      ...(r.after !== undefined ? ['+ ' + r.after] : []),
                    ])
                    .join('\n')
                : before + '\n→\n' + edit.text}
            </pre>
          </section>
        );
      })}
    </details>
  );
}
