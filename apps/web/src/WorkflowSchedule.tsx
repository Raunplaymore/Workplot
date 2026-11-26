import { useEffect, useState } from 'react';
import { CalendarClock } from 'lucide-react';
import {
  schedulePanelSchema,
  type SchedulePanel,
  type ScheduleConfig,
  type WorkflowVersion,
} from '@studio/contracts';
import { localRequest } from './local-request';
import styles from './WorkflowLibrary.module.css';

const days = ['일', '월', '화', '수', '목', '금', '토'];
const when = (n: number) =>
  new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(n);

export function WorkflowSchedule({ flow }: { flow: WorkflowVersion }) {
  const path = '/workflows/' + flow.id + '/schedule';
  const [data, setData] = useState<SchedulePanel | null>(null),
    [editing, edit] = useState(false),
    [busy, setBusy] = useState(false),
    [message, say] = useState('');
  const defaults: ScheduleConfig = {
    version: flow.version,
    enabled: true,
    weekday: 1,
    time: '09:00',
    material: { kind: 'text', value: '' },
  };
  const [form, setForm] = useState<ScheduleConfig>(defaults);
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    const c = new AbortController();
    async function read() {
      try {
        const value = schedulePanelSchema.parse(
          await (await localRequest(path, 'GET', undefined, c.signal)).json(),
        );
        if (!c.signal.aborted) setData(value);
      } catch (e) {
        if (!c.signal.aborted)
          say(e instanceof Error ? e.message : '예약 조회 실패');
      }
    }
    void read();
    const timer = setInterval(() => {
      if (!document.hidden && !editing && !busy) void read();
    }, 8000);
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [path, editing, busy]);
  const saved = data?.schedule;
  async function change(
    config: ScheduleConfig | null,
    expected: string | null,
  ) {
    setBusy(true);
    say('');
    try {
      const res = await localRequest(
        path,
        config ? 'PUT' : 'DELETE',
        config ? { config, expected } : { expected },
      );
      setData(schedulePanelSchema.parse(await res.json()));
      edit(false);
    } catch (e) {
      say(e instanceof Error ? e.message : '예약 변경 실패');
    } finally {
      setBusy(false);
    }
  }
  const [materials, setMaterials] = useState({ text: '', file: '' });
  function begin() {
    setMaterials({ text: '', file: '' });
    setBase(saved?.revision ?? null);
    setForm(saved?.config ?? defaults);
    edit(true);
    say('');
  }
  return (
    <section className={styles.schedule} aria-label="예약 실행">
      <h3>
        <CalendarClock size={16} aria-hidden="true" /> 예약 실행
      </h3>
      {saved && (
        <>
          <p>
            {saved.config.weekday === null
              ? '매일'
              : '매주 ' + days[saved.config.weekday] + '요일'}{' '}
            {saved.config.time} · 서울 · v{saved.config.version} ·{' '}
            {saved.config.enabled ? '사용 중' : 'Pause'}
          </p>
          {saved.nextAt && <p>다음 실행 {when(saved.nextAt)}</p>}
          {saved.lastAt && (
            <p>
              최근 예약 {when(saved.lastAt)} · {saved.note}{' '}
              {saved.runId && <a href={'#/runs/' + saved.runId}>실행 열기</a>}
            </p>
          )}
        </>
      )}
      {!editing ? (
        <>
          <button disabled={!data || busy} onClick={begin}>
            {saved ? 'Edit schedule' : 'Add schedule'}
          </button>
          {saved && (
            <button
              disabled={busy}
              onClick={() =>
                void change(
                  { ...saved.config, enabled: !saved.config.enabled },
                  saved.revision,
                )
              }
            >
              {saved.config.enabled ? 'Pause' : 'Resume'}
            </button>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void change(form, base);
          }}
        >
          <label>
            반복
            <select
              value={form.weekday ?? 'daily'}
              onChange={(e) =>
                setForm({
                  ...form,
                  weekday:
                    e.target.value === 'daily' ? null : Number(e.target.value),
                })
              }
            >
              <option value="daily">매일</option>
              {days.map((d, i) => (
                <option key={d} value={i}>
                  매주 {d}요일
                </option>
              ))}
            </select>
          </label>
          <label>
            시각 (서울)
            <input
              type="time"
              required
              value={form.time}
              onChange={(e) => setForm({ ...form, time: e.target.value })}
            />
          </label>
          <label>
            실행 버전
            <select
              value={form.version}
              onChange={(e) =>
                setForm({ ...form, version: Number(e.target.value) })
              }
            >
              {[
                ...new Set([
                  saved?.config.version ?? flow.version,
                  flow.version,
                ]),
              ].map((v) => (
                <option key={v} value={v}>
                  v{v}
                </option>
              ))}
            </select>
          </label>
          <label>
            자료 방식
            <select
              value={form.material.kind}
              onChange={(e) => {
                const kind = e.target.value === 'file' ? 'file' : 'text';
                setMaterials({
                  ...materials,
                  [form.material.kind]: form.material.value,
                });
                setForm({
                  ...form,
                  material: { kind, value: materials[kind] },
                });
              }}
            >
              <option value="text">고정 자료</option>
              <option value="file">매번 파일에서 읽기</option>
            </select>
          </label>
          {form.material.kind === 'file' ? (
            <label>
              자료 파일명
              <input
                placeholder="주간보고.md"
                required
                value={form.material.value}
                onChange={(e) =>
                  setForm({
                    ...form,
                    material: { kind: 'file', value: e.target.value },
                  })
                }
              />
              <small>자료 폴더 · {data?.folder} · UTF-8 .md 또는 .txt</small>
            </label>
          ) : (
            <label>
              예약 원본 자료
              <textarea
                required
                maxLength={8000}
                rows={3}
                value={form.material.value}
                onChange={(e) =>
                  setForm({
                    ...form,
                    material: { kind: 'text', value: e.target.value },
                  })
                }
              />
            </label>
          )}
          <small>
            Mac이 깨어 있고 Workplot 서버가 켜져 있을 때 실행합니다. 진행
            중이거나 승인을 기다리는 작업이 있으면 그 회차를 건너뜁니다.
          </small>
          <div>
            <button disabled={busy} type="submit">
              Save schedule
            </button>{' '}
            <button type="button" disabled={busy} onClick={() => edit(false)}>
              Cancel
            </button>{' '}
            {saved && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void change(null, base)}
              >
                Delete schedule
              </button>
            )}
          </div>
        </form>
      )}
      {message && <p role="alert">{message}</p>}
    </section>
  );
}
