import { useState, type ReactNode } from 'react';
import styles from './StepProperties.module.css';

export function StepProperties({
  roleContent,
  connections,
  execution,
}: {
  roleContent: ReactNode;
  connections: ReactNode;
  execution?: ReactNode;
}) {
  const sections = [
    { title: '역할과 지침', content: roleContent },
    { title: '단계 연결', content: connections },
    ...(execution ? [{ title: '도구와 권한', content: execution }] : []),
  ];
  const [selection, select] = useState('역할과 지침');
  const active = sections.some((s) => s.title === selection)
    ? selection
    : sections[0]!.title;
  return (
    <>
      <div
        className={styles.navigation}
        role="group"
        aria-label="단계 속성 항목"
      >
        {sections.map((s) => (
          <button
            key={s.title}
            type="button"
            aria-pressed={active === s.title}
            onClick={() => select(s.title)}
          >
            {s.title}
          </button>
        ))}
      </div>
      {sections.map((s) => (
        <section
          key={s.title}
          className={styles.content}
          aria-label={s.title}
          hidden={active !== s.title}
        >
          {s.content}
        </section>
      ))}
    </>
  );
}
