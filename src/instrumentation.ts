// Next.js Instrumentation Hook
// 서버 프로세스 시작 시 1회 실행됨
// 스케줄러 자동 복구: Railway 등 클라우드 환경에서 서버 재시작 후
// 이전에 실행 중이던 스케줄러를 자동으로 재시작

export async function register() {
  // 서버 사이드에서만 실행 (클라이언트 번들에서는 제외)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[Instrumentation] 서버 시작, 자동 복구 스케줄링...');

    // DB 연결 및 스케줄러 초기화가 완료되도록 지연 실행
    // 서버가 완전히 부팅되기 전에 실행하면 DB 연결 오류 발생 가능
    setTimeout(async () => {
      try {
        const { autoRecoverScheduler } = await import('./lib/agent-scheduler');
        await autoRecoverScheduler();
        console.log('[Instrumentation] 자동 복구 체크 완료');
      } catch (error) {
        console.error('[Instrumentation] 자동 복구 실패:', error);
      }
    }, 5000); // 5초 지연 (서버 부팅 완료 대기)
  }
}
