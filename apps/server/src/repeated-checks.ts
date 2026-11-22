export function repeatsUnchangedChecks(current: string, previous: string) {
  const unchanged = '# 구현·검증 기록\n변경 없음.';
  if (!current.startsWith(unchanged) || !previous.startsWith(unchanged))
    return false;
  function observed(s: string) {
    return s
      .slice(s.lastIndexOf('\n실제 검사:'))
      .split('\n')
      .map((line) => line.replace(/^- (?=브라우저 실측:)/, ''))
      .filter((line) => line.startsWith('브라우저 실측:'));
  }
  const a = observed(current),
    b = observed(previous);
  return (
    a.length > 0 && a.length === b.length && a.every((line, i) => line === b[i])
  );
}
