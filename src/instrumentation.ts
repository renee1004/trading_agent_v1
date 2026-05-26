// Next.js Instrumentation Hook
// 서버 프로세스 시작 시 1회 실행됨
// 스케줄러 자동 복구: Railway 등 클라우드 환경에서 서버 재시작 후
// 이전에 실행 중이던 스케줄러를 자동으로 재시작
// 주기적 헬스체크: 스케줄러가 예기치 않게 중단된 경우 감지 및 복구

export async function register() {
  // 서버 사이드에서만 실행 (클라이언트 번들에서는 제외)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[Instrumentation] 서버 시작, 자동 복구 스케줄링...');

    // 1. 초기 자동 복구 (5초 후)
    setTimeout(async () => {
      try {
        const { autoRecoverScheduler } = await import('./lib/agent-scheduler');
        await autoRecoverScheduler();
        console.log('[Instrumentation] 초기 자동 복구 체크 완료');
      } catch (error) {
        console.error('[Instrumentation] 초기 자동 복구 실패:', error);
      }
    }, 5000);

    // 2. 주기적 헬스체크 (5분마다)
    // 스케줄러가 예기치 않게 중단된 경우 감지 및 복구
    // Railway 등 클라우드 환경에서 메모리/CPU 리밋으로 프로세스가 재시작된 후
    // 스케줄러가 복구되지 않는 문제 방지
    setInterval(async () => {
      try {
        const { getSchedulerStatus, autoRecoverScheduler } = await import('./lib/agent-scheduler');
        const { getAgentStatus } = await import('./lib/trading-agent');

        const schedulerStatus = await getSchedulerStatus();
        const agentStatus = getAgentStatus();

        // 에이전트가 실행 중인데 스케줄러가 멈춘 경우 → 자동 복구
        if (agentStatus.isRunning && !schedulerStatus.isSchedulerRunning) {
          console.warn('[Health Check] 스케줄러 중단 감지! 자동 복구 시도...');
          await autoRecoverScheduler();
          console.log('[Health Check] 자동 복구 완료');
        }

        // 연속 에러가 누적된 경우 → 경고 로그
        if (schedulerStatus.errorCount > 0) {
          console.warn(`[Health Check] 스케줄러 에러 카운트: ${schedulerStatus.errorCount}/5`);
        }
      } catch (error) {
        console.error('[Health Check] 헬스체크 실패:', error);
      }
    }, 5 * 60 * 1000); // 5분마다

    console.log('[Instrumentation] 주기적 헬스체크 활성화 (5분 간격)');
  }
}
