import { useEffect, useState } from 'react';
import {
  skillRegistrationListSchema,
  type WorkflowVersion,
} from '@studio/contracts';
import { localRequest } from './local-request';

export function SkillRegistration({ flow }: { flow: WorkflowVersion }) {
  const [items, setItems] = useState<
    ReturnType<typeof skillRegistrationListSchema.parse>
  >([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const path = '/workflows/' + flow.id + '/codex-skills';
  useEffect(() => {
    const c = new AbortController();
    void localRequest(path, 'GET', undefined, c.signal)
      .then((r) => r.json())
      .then((data) => {
        if (!c.signal.aborted) {
          const list = skillRegistrationListSchema.parse(data);
          setItems(list);
          setName(list[0]?.name ?? '');
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) setNotice(e.message);
      });
    return () => c.abort();
  }, [path]);
  const current = items.find((i) => i.name === name);
  async function register() {
    setBusy(true);
    setNotice('');
    try {
      const r = await localRequest(path, 'PUT', {
        name,
        version: flow.version,
        expectedVersion: current?.version ?? null,
      });
      const [item] = skillRegistrationListSchema.parse([await r.json()]);
      setItems((prev) => [...prev.filter((i) => i.name !== name), item!]);
      setOpen(false);
      setNotice('등록 완료 · 새 Codex 대화에서 $' + name + '로 실행하세요.');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '등록에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="개인 Codex 스킬">
      {items.map((i) => (
        <p key={i.name}>
          <code>${i.name}</code> · 등록된 v{i.version}
        </p>
      ))}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)}>
          {items.length ? '등록한 스킬 관리' : 'Codex 스킬로 등록'}
        </button>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void register();
          }}
        >
          <label>
            Codex 스킬 이름{' '}
            <input
              required
              maxLength={64}
              pattern="[a-z][a-z0-9]*(-[a-z0-9]+)*"
              value={name}
              placeholder="shop-intro"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p>
            개인 스킬 폴더에 등록합니다. 다른 프로젝트에서도 이 흐름의 v
            {flow.version}을 사용합니다.
          </p>
          <button
            type="submit"
            disabled={busy || !name || current?.version === flow.version}
          >
            {current ? 'v' + flow.version + '로 업데이트' : '등록'}
          </button>{' '}
          <button type="button" disabled={busy} onClick={() => setOpen(false)}>
            닫기
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
