import { test, expect } from 'vitest';
import { quotaRetryTime } from '../src/quota-classifier.js';
test('only structured usage failures schedule another attempt', () => {
  const now = 1700000000000,
    at = now + 3600000;
  const event = (error: unknown) =>
    JSON.stringify({ type: 'turn.failed', error });
  expect(
    quotaRetryTime(
      event({ code: 'usage_limit_reached', resets_at: at / 1000 }),
      now,
    ),
  ).toBe(at);
  expect(
    quotaRetryTime(event({ message: "You've hit your usage limit." }), now),
  ).toBe(now + 900000);
  expect(
    quotaRetryTime(event({ message: 'network unavailable' }), now),
  ).toBeUndefined();
  expect(
    quotaRetryTime(
      JSON.stringify({
        type: 'item.completed',
        item: { text: "You've hit your usage limit." },
      }),
      now,
    ),
  ).toBeUndefined();
  expect(
    quotaRetryTime(
      event({ code: 'usage_limit_reached' }) + '\n{"type":"turn.completed"}',
      now,
    ),
  ).toBeUndefined();
});
