import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, GitBranch, NotebookPen, ShieldCheck } from 'lucide-react';
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
    {
      id: 'role',
      title: '역할과 지침',
      icon: NotebookPen,
      content: roleContent,
    },
    {
      id: 'connections',
      title: '단계 연결',
      icon: GitBranch,
      content: connections,
    },
    ...(execution
      ? [
          {
            id: 'tools',
            title: '도구와 권한',
            icon: ShieldCheck,
            content: execution,
          },
        ]
      : []),
  ];
  const prefix = useId();
  const [active, setActive] = useState<string | null>('role');
  return (
    <div className={styles.panels} role="group" aria-label="단계 속성 항목">
      {sections.map(({ id, title, icon: Icon, content }) => {
        const open = active === id;
        const panelId = prefix + '-' + id;
        return (
          <section
            key={id}
            className={styles.panel}
            data-open={open}
            aria-labelledby={panelId + '-title'}
          >
            <h3 className={styles.heading}>
              <button
                id={panelId + '-title'}
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setActive(open ? null : id)}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{title}</span>
                <ChevronDown
                  className={styles.chevron}
                  size={16}
                  aria-hidden="true"
                />
              </button>
            </h3>
            <div id={panelId} className={styles.content} hidden={!open}>
              {content}
            </div>
          </section>
        );
      })}
    </div>
  );
}
