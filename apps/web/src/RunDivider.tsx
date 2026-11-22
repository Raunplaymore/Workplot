import { useLayoutEffect, useRef, useState } from 'react';
import styles from './WorkflowStudio.module.css';

const storageKey = 'workplot.runDetailFraction';
const defaultShare = 0.32;
function preference() {
  try {
    const n = Number(localStorage.getItem(storageKey));
    if (n > 0 && n < 1) return n;
  } catch {
    /* Storage is optional. */
  }
  return defaultShare;
}

export function RunDivider() {
  const divider = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; offset: number } | null>(null);
  const [share, setShare] = useState(preference);
  const [width, setWidth] = useState(0);
  const minLeft = 300,
    gap = 12;
  const maxLeft = Math.max(minLeft, width - gap - 260);
  const clamp = (n: number) => Math.min(maxLeft, Math.max(minLeft, n));
  const left = clamp(Math.round(width * (1 - share)) - gap);
  useLayoutEffect(() => {
    const root = divider.current?.parentElement;
    if (!root) return;
    const measure = () => setWidth(root.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const root = divider.current?.parentElement;
    if (width && root)
      root.style.setProperty('--run-detail-width', width - left - gap + 'px');
  }, [width, left]);
  function change(leftWidth: number) {
    if (!width) return;
    const fraction = (width - gap - clamp(leftWidth)) / width;
    setShare(fraction);
  }
  function remember(fraction: number) {
    try {
      localStorage.setItem(storageKey, String(fraction));
    } catch {
      /* private mode */
    }
  }
  function moveAndSave(n: number) {
    change(n);
    if (width) remember((width - gap - clamp(n)) / width);
  }
  return (
    <div
      ref={divider}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="문서와 실행 상세 사이 너비 조절"
      aria-controls="run-documents"
      aria-valuemin={minLeft}
      aria-valuemax={maxLeft}
      aria-valuenow={left}
      aria-valuetext={`문서 ${left}px`}
      className={styles.runDivider}
      title="드래그 또는 ← → 키로 너비 조절 · 두 번 클릭해 초기화"
      onPointerDown={(e) => {
        if (!e.isPrimary || e.button !== 0) return;
        drag.current = {
          pointer: e.pointerId,
          offset: e.clientX - e.currentTarget.getBoundingClientRect().left,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
      }}
      onPointerMove={(e) => {
        if (drag.current?.pointer === e.pointerId)
          change(
            e.clientX -
              e.currentTarget.parentElement!.getBoundingClientRect().left -
              drag.current.offset,
          );
      }}
      onPointerUp={(e) => {
        if (drag.current?.pointer !== e.pointerId) return;
        moveAndSave(
          e.clientX -
            e.currentTarget.parentElement!.getBoundingClientRect().left -
            drag.current.offset,
        );
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
      onDoubleClick={() => {
        setShare(defaultShare);
        remember(defaultShare);
      }}
      onKeyDown={(e) => {
        const delta = e.shiftKey ? 80 : 24;
        const positions: Record<string, number> = {
          ArrowLeft: left - delta,
          ArrowRight: left + delta,
          Home: minLeft,
          End: maxLeft,
        };
        if (e.key in positions) {
          e.preventDefault();
          moveAndSave(positions[e.key]!);
        }
      }}
    />
  );
}
