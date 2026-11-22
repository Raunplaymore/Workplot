import styles from './WorkflowLibrary.module.css';
import { useState } from 'react';
import type { RequestFiles } from '@studio/contracts';
import { localRequest } from './local-request';

export function RequestAttachments({
  value,
  change,
}: {
  value: RequestFiles;
  change: (v: RequestFiles) => void;
}) {
  const [path, setPath] = useState(''),
    [error, setError] = useState(''),
    [picking, setPicking] = useState(false);
  function add(raw: string) {
    const name = raw.trim();
    if (!name) return;
    change({ ...value, references: [...new Set([...value.references, name])] });
    setPath('');
  }
  async function pick(kind: 'file' | 'folder', workspace = false) {
    setPicking(true);
    setError('');
    try {
      const { path } = await (
        await localRequest('/request-files/choose', 'POST', { kind })
      ).json();
      if (path) {
        if (workspace) change({ ...value, workspace: path });
        else add(path);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setPicking(false);
    }
  }
  return (
    <details className={styles.attachments}>
      <summary>
        첨부 · 작업 폴더
        {value.references.length
          ? ' · 참고 ' + value.references.length + '개'
          : ''}
        {value.workspace ? ' · 작업 폴더 지정됨' : ''}
      </summary>
      <small>
        참고 문서·소스·이미지는 실행할 때 복사해 후속 세션에서도 사용합니다.
      </small>
      <div>
        <label>
          참고 경로{' '}
          <input
            value={path}
            placeholder="파일 또는 폴더 경로"
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add(path);
              }
            }}
          />
        </label>
        <button
          type="button"
          disabled={!path.trim() || picking}
          onClick={() => add(path)}
        >
          첨부
        </button>
        <button
          type="button"
          disabled={picking}
          onClick={() => void pick('file')}
        >
          파일 선택
        </button>
        <button
          type="button"
          disabled={picking}
          onClick={() => void pick('folder')}
        >
          폴더 선택
        </button>
      </div>
      {value.references.map((name) => (
        <div key={name}>
          {name}{' '}
          <button
            type="button"
            aria-label={name + ' 제거'}
            onClick={() =>
              change({
                ...value,
                references: value.references.filter((x) => x !== name),
              })
            }
          >
            제거
          </button>
        </div>
      ))}
      <label>
        수정할 작업 폴더{' '}
        <input
          placeholder="쓰기 허용할 폴더 경로"
          value={value.workspace ?? ''}
          onChange={(e) =>
            change({ ...value, workspace: e.target.value.trim() || undefined })
          }
        />
      </label>
      <button
        type="button"
        disabled={picking}
        onClick={() => void pick('folder', true)}
      >
        작업 폴더 선택
      </button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
