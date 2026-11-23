import { afterEach, expect, test, vi } from 'vitest';
import { codexDeadline, type CliItemEvent } from '../src/codex-deadline.js';

afterEach(() => vi.useRealTimers());
const command = {
  type: 'item.completed',
  item: { type: 'command_execution', exit_code: 0 },
};
const change = {
  type: 'item.completed',
  item: {
    type: 'file_change',
    status: 'completed',
    changes: [{ path: 'app.ts' }],
  },
};
test.each([command, change])(
  'completed work can pass four minutes, then stops after four idle minutes',
  (event) => {
    vi.useFakeTimers();
    const expire = vi.fn(),
      clock = codexDeadline(true, false, expire);
    vi.advanceTimersByTime(190000);
    clock.observe(event);
    vi.advanceTimersByTime(239999);
    expect(expire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(expire.mock.calls).toEqual([['idle']]);
  },
);
test('ongoing productive work reaches its absolute limit exactly once', () => {
  vi.useFakeTimers();
  const expire = vi.fn(),
    clock = codexDeadline(true, false, expire);
  for (let i = 0; i < 7; i++) {
    vi.advanceTimersByTime(60000);
    clock.observe(command);
  }
  vi.advanceTimersByTime(120000);
  expect(expire.mock.calls).toEqual([['maximum']]);
});
test('reasoning, starts, failed commands and unsuccessful edits do not extend the window', () => {
  vi.useFakeTimers();
  const expire = vi.fn(),
    clock = codexDeadline(true, false, expire);
  vi.advanceTimersByTime(230000);
  for (const e of [
    null,
    { type: 'item.started', item: command.item },
    { type: 'item.completed', item: { type: 'reasoning' } },
    { type: 'item.completed', item: { ...command.item, exit_code: 1 } },
    { type: 'item.completed', item: { ...change.item, status: 'failed' } },
  ] satisfies (CliItemEvent | null)[])
    clock.observe(e);
  vi.advanceTimersByTime(10000);
  expect(expire.mock.calls).toEqual([['idle']]);
});
test('document calls keep their fixed limits and closing a call cancels both timers', () => {
  vi.useFakeTimers();
  const doc = vi.fn(),
    ui = vi.fn(),
    closed = vi.fn();
  const read = codexDeadline(false, false, doc),
    screen = codexDeadline(false, true, ui),
    write = codexDeadline(true, false, closed);
  vi.advanceTimersByTime(60000);
  read.observe(command);
  screen.observe(command);
  write.dispose();
  write.observe(command);
  vi.advanceTimersByTime(60000);
  expect(doc.mock.calls).toEqual([['fixed']]);
  expect(ui).not.toHaveBeenCalled();
  vi.advanceTimersByTime(360000);
  expect(ui.mock.calls).toEqual([['fixed']]);
  expect(closed).not.toHaveBeenCalled();
});
