// Earlier workspaces saved each observation on a soft Markdown line break.
export function formatUiEvidenceMarkdown(text: string): string {
  if (
    !text.startsWith('# 구현·검증 기록\n') ||
    /^## (수정 후 검사|검사 결과)$/m.test(text)
  )
    return text;
  const lines = text.split('\n');
  const build = lines.findLastIndex((line) => line.startsWith('실제 검사:'));
  if (build < 0) return text;
  const before = lines.lastIndexOf('수정 전 검사 (캡처는 before/):', build);
  const after = lines.lastIndexOf('수정 후 검사:', build);
  const hasBaseline = before >= 0 && after > before;
  function section(title: string, rows: string[]) {
    const checks = rows.filter((line) => line.startsWith('브라우저 실측:'));
    const passed = checks.filter((line) => line.includes(' · 통과 · ')).length;
    const failed = checks.filter((line) => line.includes(' · 미달 · ')).length;
    const blocks = ['## ' + title];
    if (checks.length)
      blocks.push('통과 ' + passed + '건 · 미달 ' + failed + '건');
    let items: string[] = [];
    for (const line of rows) {
      if (line.startsWith('브라우저 실측:')) {
        items.push('- ' + line);
        continue;
      }
      if (items.length) {
        blocks.push(items.join('\n'));
        items = [];
      }
      if (line.trim()) blocks.push(line);
    }
    if (items.length) blocks.push(items.join('\n'));
    return blocks.join('\n\n');
  }
  const blocks = [
    lines
      .slice(0, hasBaseline ? before : build)
      .join('\n')
      .trimEnd(),
  ];
  if (hasBaseline)
    blocks.push(section('수정 전 검사', lines.slice(before + 1, after)));
  blocks.push(
    section(hasBaseline ? '수정 후 검사' : '검사 결과', lines.slice(build)),
  );
  return blocks.join('\n\n') + (text.endsWith('\n') ? '\n' : '');
}
