export type DeadlineReason = 'idle' | 'maximum' | 'fixed';
export type CliItemEvent = {
  type?: string;
  item?: {
    type?: string;
    command?: string;
    exit_code?: number;
    status?: string;
    changes?: unknown[];
  };
};

// Deadline is per CLI call. Productive work can use a second four-minute window.
export function codexDeadline(
  writable: boolean,
  uiWork: boolean,
  expire: (reason: DeadlineReason) => void,
) {
  const windowMs = writable || uiWork ? 240_000 : 120_000;
  let active = true;
  function finish(reason: DeadlineReason) {
    if (!active) return;
    dispose();
    expire(reason);
  }
  const idle = setTimeout(() => finish(writable ? 'idle' : 'fixed'), windowMs);
  const maximum = writable
    ? setTimeout(() => finish('maximum'), 2 * windowMs)
    : undefined;
  function dispose() {
    active = false;
    clearTimeout(idle);
    clearTimeout(maximum);
  }
  function observe(event: CliItemEvent | null) {
    if (!active || !writable || event?.type !== 'item.completed') return;
    const item = event.item;
    if (
      (item?.type === 'command_execution' && item.exit_code === 0) ||
      (item?.type === 'file_change' &&
        item.status === 'completed' &&
        Array.isArray(item.changes) &&
        item.changes.length > 0)
    ) {
      idle.refresh();
    }
  }
  return { observe, dispose };
}
