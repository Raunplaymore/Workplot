// API use remains disabled until the user explicitly requests it.
if (process.argv.includes('--live')) {
  console.error(
    'API 사용 금지: 사용자 명시 요청 전에는 실제 호출을 실행할 수 없습니다.',
  );
  process.exitCode = 1;
} else {
  console.info(
    '로컬 준비 확인만 가능합니다. API 호출 경로는 비활성화되어 있습니다.',
  );
}
