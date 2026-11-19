import { useEffect, useState } from 'react';
import { healthSchema, toolsSchema, type ToolStatus } from '@studio/contracts';
import styles from './App.module.css';
import { WorkflowStudio } from './WorkflowStudio';

export function App() {
  const [connection, setConnection] = useState('로컬 서버 확인 중');
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [toolsError, setToolsError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/tools', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('도구 확인 실패');
        setTools(toolsSchema.parse(await response.json()));
      })
      .catch(() => {
        if (!controller.signal.aborted) setToolsError(true);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    function check() {
      void fetch('/api/health', { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('서버 응답 오류');
          healthSchema.parse(await response.json());
          setConnection('로컬 서버 연결됨');
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setConnection('로컬 서버에 연결할 수 없음');
        })
        .finally(() => {
          if (!controller.signal.aborted) timer = setTimeout(check, 5000);
        });
    }
    check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className={styles.app}>
      <WorkflowStudio
        connected={connection === '로컬 서버 연결됨'}
        codexAvailable={
          tools?.some(
            (tool) => tool.id === 'codex' && tool.status === 'detected',
          ) ?? false
        }
      />
      <footer className={styles.footer}>
        <span role="status">{connection}</span>
        <details className={styles.tools}>
          <summary>내 에이전트 도구</summary>
          <section aria-labelledby="tools-title">
            <h2 id="tools-title">내 에이전트 도구</h2>
            <p>
              설치를 먼저 확인하고, 실행할 때 Codex의 ChatGPT 로그인 상태를
              확인합니다.
            </p>
            {toolsError ? (
              <p role="alert">
                도구 정보를 가져올 수 없습니다. 서버 연결을 확인하고
                새로고침하세요.
              </p>
            ) : tools === null ? (
              <p>설치된 도구 확인 중…</p>
            ) : (
              <ul>
                {tools.map((tool) => (
                  <li key={tool.id}>
                    <strong>
                      {tool.id === 'claude' ? 'Claude Code' : 'Codex'}
                    </strong>
                    <span>
                      {tool.status === 'detected'
                        ? `설치 확인 · ${tool.version}`
                        : tool.status === 'not_found'
                          ? '서버에서 찾지 못함'
                          : '버전 확인 실패'}
                    </span>
                    <small>로그인 미확인</small>
                  </li>
                ))}
              </ul>
            )}
            <p>
              설치 후에도 찾지 못하면 도구가 실행되는 터미널에서 로컬 서버를
              다시 시작하세요.
            </p>
          </section>
        </details>
      </footer>
    </div>
  );
}
