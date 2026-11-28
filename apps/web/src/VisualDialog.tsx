import { useRef, type ReactNode } from 'react';
import styles from './MarkdownDocument.module.css';

export function VisualDialog({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()}>
        {label}
      </button>
      <dialog
        ref={dialog}
        className={styles.visualDialog}
        aria-label={label}
        onCancel={(event) => event.stopPropagation()}
      >
        <header>
          <strong>{label}</strong>
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </header>
        {children}
      </dialog>
    </>
  );
}
