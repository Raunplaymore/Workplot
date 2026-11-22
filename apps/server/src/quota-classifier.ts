// Codex reports provider failures in its JSON event stream. Generated document text is never an error signal.
export function quotaRetryTime(
  output: string,
  now = Date.now(),
): number | undefined {
  for (const line of output.split('\n').reverse()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === 'turn.completed') return;
    if (event?.type !== 'turn.failed' && event?.type !== 'error') continue;
    const err = event.error ?? event;
    const code = err.code ?? err.codex_error_info ?? err.codexErrorInfo;
    const message = typeof err === 'string' ? err : err.message;
    if (
      ![
        'usage_limit_reached',
        'usageLimitExceeded',
        'usage_limit_exceeded',
        'weekly_limit_reached',
      ].includes(code) &&
      !(
        typeof message === 'string' &&
        /(?:you(?:['’]ve| have) (?:hit|reached) your usage limit|weekly (?:usage )?limit (?:has been |was )?(?:reached|exhausted)|usage_limit_reached)/i.test(
          message,
        )
      )
    )
      continue;
    const reset = err.resets_at ?? err.reset_at;
    const at =
      typeof reset === 'number'
        ? reset < 1e12
          ? reset * 1000
          : reset
        : typeof reset === 'string'
          ? Date.parse(reset)
          : NaN;
    if (Number.isSafeInteger(at) && at > now && at < 8640000000000000)
      return at;
    return now + 15 * 60_000;
  }
}
