import { createContext, useId, useState, type ReactNode } from 'react';
import { ChevronDown, GitBranch, NotebookPen, ShieldCheck } from 'lucide-react';
import styles from './StepProperties.module.css';

export const ConnectionsOpen = createContext(false);

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
      title: 'Role and instructions',
      icon: NotebookPen,
      content: roleContent,
    },
    {
      id: 'connections',
      title: 'Step connections',
      icon: GitBranch,
      content: connections,
    },
    ...(execution
      ? [
          {
            id: 'tools',
            title: 'Tools and permissions',
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
              {id === 'connections' ? (
                <ConnectionsOpen.Provider value={open}>
                  {content}
                </ConnectionsOpen.Provider>
              ) : (
                content
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
