import { useEffect, useState } from 'react';
import { localRequest } from './local-request';

type Capture = { image: string; phases: string[] };
const scenes: Record<string, string> = {
  editor: '흐름 설계',
  dashboard: '실행 현황',
  document: '문서 상세',
  layout: '작업공간 배치',
};
function scene(image: string) {
  const [width, area = ''] = image.replace('.png', '').split('-');
  return width + 'px · ' + (scenes[area] ?? area);
}
export function EvidenceCaptures({
  runId,
  file,
  text,
}: {
  runId: string;
  file: string;
  text: string;
}) {
  const path =
    '/runs/' + runId + '/results/' + encodeURIComponent(file) + '/captures';
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [choice, select] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    localRequest(path, 'GET', undefined, controller.signal)
      .then((r) => r.json())
      .then((items: Capture[]) => {
        if (!controller.signal.aborted) setCaptures(items);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [path]);
  const primary = text.match(/장면\s*·\s*([\w-]+\.png)/)?.[1];
  const active =
    captures.find((c) => c.image === choice) ??
    captures.find((c) => c.image === primary) ??
    captures[0];
  if (failed) return <p role="status">화면 캡처 목록을 불러오지 못했습니다.</p>;
  if (!active) return null;
  return (
    <section aria-label="전후 캡처">
      <h3>전후 캡처</h3>
      <label>
        비교 화면{' '}
        <select value={active.image} onChange={(e) => select(e.target.value)}>
          {captures.map((c) => (
            <option key={c.image} value={c.image}>
              {scene(c.image)}
            </option>
          ))}
        </select>
      </label>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))',
          gap: '1rem',
          marginBlock: '1rem',
        }}
      >
        {['before', 'after'].map((phase) => {
          const label = phase === 'before' ? '수정 전' : '수정 후';
          const url = '/api' + path + '/' + phase + '/' + active.image;
          return (
            <figure key={phase} style={{ margin: 0 }}>
              <figcaption>{label}</figcaption>
              {active.phases.includes(phase) ? (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={label + ' 원본 열기'}
                >
                  <img
                    alt={label + ' ' + scene(active.image)}
                    src={url}
                    style={{
                      width: '100%',
                      height: 160,
                      objectFit: 'contain',
                      objectPosition: 'top left',
                    }}
                  />
                </a>
              ) : (
                <span>저장된 캡처 없음</span>
              )}
            </figure>
          );
        })}
      </div>
    </section>
  );
}
