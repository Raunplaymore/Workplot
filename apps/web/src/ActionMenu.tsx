import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import styles from './ActionMenu.module.css';
export type MenuPosition = { x: number; y: number };
export function anchorMenu(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 3 };
}
type Item = {
  label: string;
  action: () => void;
  disabled?: boolean;
  divider?: boolean;
  danger?: boolean;
  hint?: string;
};
export function ActionMenu({
  position,
  items,
  close,
  label,
}: {
  position: MenuPosition;
  items: Item[];
  close: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = ref.current!;
    const prior = document.activeElement;
    const move = () => {
      box.style.left =
        Math.max(
          4,
          Math.min(position.x, window.innerWidth - box.offsetWidth - 4),
        ) + 'px';
      box.style.top =
        Math.max(
          4,
          Math.min(position.y, window.innerHeight - box.offsetHeight - 4),
        ) + 'px';
    };
    move();
    box.querySelector<HTMLButtonElement>('button:enabled')?.focus();
    function outside(e: PointerEvent) {
      if (!box.contains(e.target as Node)) close();
    }
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', move);
    window.addEventListener('hashchange', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', move);
      window.removeEventListener('hashchange', close);
      if (
        prior instanceof HTMLElement &&
        prior.isConnected &&
        (document.activeElement === document.body ||
          box.contains(document.activeElement))
      )
        prior.focus({ preventScroll: true });
    };
  }, [position]);
  return createPortal(
    <div
      className={styles.menu}
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={(e) => {
        const buttons = Array.from(
            ref.current!.querySelectorAll<HTMLButtonElement>('button:enabled'),
          ),
          i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'Escape' || e.key === 'Tab') {
          if (e.key === 'Escape') e.preventDefault();
          close();
          return;
        }
        const index =
          e.key === 'ArrowDown'
            ? (i + 1) % buttons.length
            : e.key === 'ArrowUp'
              ? (i + buttons.length - 1) % buttons.length
              : e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? buttons.length - 1
                  : -1;
        if (index >= 0) {
          e.preventDefault();
          buttons[index]?.focus();
        }
      }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          data-divider={it.divider}
          data-danger={it.danger}
          disabled={it.disabled}
          onClick={() => {
            close();
            it.action();
          }}
        >
          {it.label}
          {it.hint && <small>{it.hint}</small>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
