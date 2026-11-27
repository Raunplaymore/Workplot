import { useEffect, useId, useRef, type ReactNode } from 'react';
import styles from './WorkflowSettingsDialog.module.css';

export function RunDetailDialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const el = ref.current!;
    el.showModal();
    return () => el.close();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={id}
      className={styles.dialog}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button onClick={close}>Close</button>
      </header>
      <div className={styles.reading}>{children}</div>
    </dialog>
  );
}
