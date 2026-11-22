import { useEffect, useRef, useState } from 'react';
import { localRequest } from './local-request';

export function NodeInstructions({
  title,
  context,
  value,
  change,
  available,
}: {
  title: string;
  context: string;
  value: string;
  change: (text: string) => void;
  available: boolean;
}) {
  const [request, setRequest] = useState('');
  const [proposal, setProposal] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setProposal('');
    setPending(false);
    setError('');
    return () => active.current?.abort();
  }, [value, title, context]);
  async function ask() {
    if (pending || !request.trim()) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setError('');
    try {
      const response = await localRequest(
        '/node-instructions',
        'POST',
        {
          title,
          context,
          instructions: proposal || value,
          request: request.trim(),
        },
        controller.signal,
      );
      const result = await response.json();
      if (!controller.signal.aborted) {
        setProposal(result.instructions);
        setRequest('');
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '제안 요청 실패');
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <section aria-label="노드 역할 편집">
      <h3>이 단계의 역할과 지침</h3>
      <label>
        역할 지침
        <textarea
          aria-label="작업 지침"
          rows={7}
          maxLength={8000}
          value={value}
          onChange={(e) => change(e.target.value)}
        />
      </label>
      {proposal && (
        <label>
          AI 수정안
          <textarea rows={7} readOnly value={proposal} />
        </label>
      )}
      <label>
        AI에게 지침 수정 요청
        <textarea
          rows={2}
          maxLength={2000}
          value={request}
          disabled={pending}
          onChange={(e) => setRequest(e.target.value)}
          placeholder={
            proposal
              ? '수정안에서 더 바꿀 점'
              : '이 역할에서 보완할 점을 적어 주세요'
          }
        />
      </label>
      <button
        type="button"
        disabled={!available || pending || !request.trim()}
        onClick={() => void ask()}
      >
        {pending ? '제안 작성 중…' : '수정안 요청'}
      </button>
      {proposal && (
        <>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              change(proposal);
              setProposal('');
              setRequest('');
            }}
          >
            지침에 적용
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setProposal('');
              setRequest('');
            }}
          >
            제안 취소
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
