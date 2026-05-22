// 서버 사이드 에이전트 스케줄러
// 브라우저 없이 서버에서 24/7 자동매매 실행
// DB 기반 상태 영속화 - 서버 재시작해도 자동 복구

import { db } from './db';
import { runAgentCycle, startAgent, stopAgent, getAgentStatus, addLog as addAgentLog } from './trading-agent';

// 스케줄러 설정
export interface SchedulerConfig {
  cycleIntervalMs: number;        // 사이클 주기 (기본 60초)
  tradeOnlyMarketHours: boolean;  // 장시간에만 거래
  domesticMarketOpen: string;     // 국내 장 시작 (HH:mm)
  domesticMarketClose: string;    // 국내 장 종료 (HH:mm)
  overseasMarketOpen: string;     // 해외 장 시작 (HH:mm, 한국시간)
  overseasMarketClose: string;    // 해외 장 종료 (HH:mm, 한국시간)
}

// 스케줄러 상태
interface SchedulerState {
  isSchedulerRunning: boolean;
  intervalId: ReturnType<typeof setInterval> | null;
  config: SchedulerConfig;
  isCycleRunning: boolean;        // 현재 사이클 실행 중인지
  lastCycleStartTime: Date | null;
  errorCount: number;             // 연속 에러 횟수
  startedAt: Date | null;
}

let schedulerState: SchedulerState = {
  isSchedulerRunning: false,
  intervalId: null,
  config: {
    cycleIntervalMs: 60000,
    tradeOnlyMarketHours: true,
    domesticMarketOpen: '08:30',   // 장전 시간외 + 동시호가 포함
    domesticMarketClose: '18:00', // 시간외 단일가까지 포함
    overseasMarketOpen: '23:30',
    overseasMarketClose: '06:00',
  },
  isCycleRunning: false,
  lastCycleStartTime: null,
  errorCount: 0,
  startedAt: null,
};

const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * 한국시간(Asia/Seoul) 기준 현재 시간 및 요일 정보 반환
 * Railway 등 UTC 서버에서도 정확한 장시간 판단을 위해 필수
 * 
 * 구현 방식: UTC 오프셋 직접 계산
 * - toLocaleString + new Date() 파싱은 환경마다 결과가 다를 수 있어
 *   getTimezoneOffset() 기반 직접 계산 사용
 * - KST = UTC+9
 */
function getKSTNow(): { hours: number; minutes: number; totalMinutes: number; dayOfWeek: number } {
  const now = new Date();
  // UTC 밀리초 = 로컬 시간 + 로컬 타임존 오프셋(분→ms)
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  // KST = UTC + 9시간
  const kstMs = utcMs + 9 * 3600000;
  const kstDate = new Date(kstMs);
  const hours = kstDate.getHours();
  const minutes = kstDate.getMinutes();
  const dayOfWeek = kstDate.getDay(); // 0=일요일, 6=토요일
  return { hours, minutes, totalMinutes: hours * 60 + minutes, dayOfWeek };
}

/**
 * 영업일(주말 제외) 여부 확인
 * 한국 주식시장은 토요일(6), 일요일(0)에 열지 않음
 * 해외(미국) 주식시장도 토요일, 일요일에 열지 않음
 */
function isWeekday(dayOfWeek: number): boolean {
  return dayOfWeek !== 0 && dayOfWeek !== 6;
}

/**
 * 국내 주식 거래세션 정보
 * KIS API 주문구분코드(ORD_DVSN) 매핑 포함
 *
 * 세션별 주문 가능 방식:
 * - 장전 시간외: 종가 주문만 (ORD_DVSN='61')
 * - 동시호가: 지정가/시장가 (ORD_DVSN='00'/'01')
 * - 정규장: 지정가/시장가/조건부지정가 (ORD_DVSN='00'/'01'/'02')
 * - 장후 시간외: 종가 주문만 (ORD_DVSN='81')
 * - 시간외 단일가: 단일가 주문 (ORD_DVSN='62')
 */
export type DomesticSession =
  | 'PREMARKET_CLOSE'     // 장전 시간외 종가 (08:30~08:40)
  | 'OPENING_CALL_AUCTION' // 시초가 동시호가 (08:30~09:00)
  | 'REGULAR'             // 정규장 (09:00~15:30)
  | 'CLOSING_CALL_AUCTION' // 장마감 동시호가 (15:20~15:30, 정규장에 포함)
  | 'POSTMARKET_CLOSE'    // 장후 시간외 종가 (15:40~16:00)
  | 'AFTERHOURS_SINGLE'   // 시간외 단일가 (16:00~18:00)
  | 'CLOSED';             // 장외

export interface DomesticSessionInfo {
  session: DomesticSession;
  /** KIS 주문구분코드 (ORD_DVSN) */
  orderDivision: '00' | '01' | '02' | '61' | '62' | '81';
  /** 사람이 읽을 수 있는 세션명 */
  label: string;
}

/**
 * 현재 KST 기준 국내 주식 거래세션 판별
 * 주문 시 세션에 맞는 ORD_DVSN 코드를 반환
 *
 * 세션 시간 (KST 기준, 평일만):
 * 08:30~08:40  장전 시간외 종가      → '61'
 * 08:30~09:00  시초가 동시호가      → '00' (지정가)
 * 09:00~15:30  정규장               → '01' (시장가, 기본)
 * 15:40~16:00  장후 시간외 종가      → '81'
 * 16:00~18:00  시간외 단일가         → '62'
 */
export function getDomesticSession(): DomesticSessionInfo {
  const { totalMinutes, dayOfWeek } = getKSTNow();

  // 주말
  if (!isWeekday(dayOfWeek)) {
    return { session: 'CLOSED', orderDivision: '00', label: '휴장 (주말)' };
  }

  // 08:30~08:40: 장전 시간외 종가
  if (totalMinutes >= 510 && totalMinutes < 520) { // 08:30~08:40
    return { session: 'PREMARKET_CLOSE', orderDivision: '61', label: '장전 시간외 종가' };
  }

  // 08:40~09:00: 시초가 동시호가
  if (totalMinutes >= 520 && totalMinutes < 540) { // 08:40~09:00
    return { session: 'OPENING_CALL_AUCTION', orderDivision: '00', label: '시초가 동시호가' };
  }

  // 09:00~15:30: 정규장
  if (totalMinutes >= 540 && totalMinutes <= 930) { // 09:00~15:30
    return { session: 'REGULAR', orderDivision: '01', label: '정규장' };
  }

  // 15:30~15:40: 정규장 직후 대기 (주문 불가)
  if (totalMinutes > 930 && totalMinutes < 940) { // 15:30~15:40
    return { session: 'CLOSED', orderDivision: '00', label: '장간 대기' };
  }

  // 15:40~16:00: 장후 시간외 종가
  if (totalMinutes >= 940 && totalMinutes < 960) { // 15:40~16:00
    return { session: 'POSTMARKET_CLOSE', orderDivision: '81', label: '장후 시간외 종가' };
  }

  // 16:00~18:00: 시간외 단일가
  if (totalMinutes >= 960 && totalMinutes <= 1080) { // 16:00~18:00
    return { session: 'AFTERHOURS_SINGLE', orderDivision: '62', label: '시간외 단일가' };
  }

  return { session: 'CLOSED', orderDivision: '00', label: '장외' };
}

/**
 * 장시간 체크
 * 국내: 08:30~18:00 (전체 거래세션, 평일만), 해외: 23:30~06:00 (평일만, 한국시간)
 * Railway 등 UTC 서버에서도 정확한 판단을 위해 getKSTNow() 사용
 *
 * 국내 거래세션 전체 (KST 기준):
 * 08:30~08:40  장전 시간외 종가
 * 08:30~09:00  시초가 동시호가
 * 09:00~15:30  정규장
 * 15:40~16:00  장후 시간외 종가
 * 16:00~18:00  시간외 단일가
 *
 * 주말 체크: 토요일/일요일에는 시간과 무관하게 항상 false
 */
export function isMarketHours(market: 'DOMESTIC' | 'OVERSEAS' | 'ALL'): boolean {
  const { totalMinutes: currentMinutes, dayOfWeek } = getKSTNow();

  // 주말(토/일)에는 장시간이 아님
  if (!isWeekday(dayOfWeek)) {
    return false;
  }

  if (market === 'DOMESTIC' || market === 'ALL') {
    const [openH, openM] = schedulerState.config.domesticMarketOpen.split(':').map(Number);
    const [closeH, closeM] = schedulerState.config.domesticMarketClose.split(':').map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;

    if (currentMinutes >= openMinutes && currentMinutes <= closeMinutes) {
      return true;
    }
  }

  if (market === 'OVERSEAS' || market === 'ALL') {
    const [openH, openM] = schedulerState.config.overseasMarketOpen.split(':').map(Number);
    const [closeH, closeM] = schedulerState.config.overseasMarketClose.split(':').map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH * 60 + closeM;

    // 자정을 넘나드는 경우 (예: 23:30 ~ 06:00)
    if (openMinutes > closeMinutes) {
      if (currentMinutes >= openMinutes || currentMinutes <= closeMinutes) {
        return true;
      }
    } else {
      if (currentMinutes >= openMinutes && currentMinutes <= closeMinutes) {
        return true;
      }
    }
  }

  return false;
}

/**
 * DB에서 스케줄러 설정 로드
 */
export async function loadSchedulerConfig(): Promise<SchedulerConfig> {
  try {
    const config = await db.agentConfig.findFirst();
    if (config) {
      schedulerState.config = {
        cycleIntervalMs: config.cycleIntervalMs,
        tradeOnlyMarketHours: config.tradeOnlyMarketHours,
        domesticMarketOpen: config.domesticMarketOpen,
        domesticMarketClose: config.domesticMarketClose,
        overseasMarketOpen: config.overseasMarketOpen,
        overseasMarketClose: config.overseasMarketClose,
      };
    }
  } catch (error) {
    console.error('[Scheduler] 설정 로드 실패:', error);
  }
  return { ...schedulerState.config };
}

/**
 * DB에 스케줄러 설정 저장
 */
export async function saveSchedulerConfig(config: Partial<SchedulerConfig>): Promise<void> {
  try {
    const existing = await db.agentConfig.findFirst();
    if (existing) {
      await db.agentConfig.update({
        where: { id: existing.id },
        data: {
          ...(config.cycleIntervalMs !== undefined && { cycleIntervalMs: config.cycleIntervalMs }),
          ...(config.tradeOnlyMarketHours !== undefined && { tradeOnlyMarketHours: config.tradeOnlyMarketHours }),
          ...(config.domesticMarketOpen !== undefined && { domesticMarketOpen: config.domesticMarketOpen }),
          ...(config.domesticMarketClose !== undefined && { domesticMarketClose: config.domesticMarketClose }),
          ...(config.overseasMarketOpen !== undefined && { overseasMarketOpen: config.overseasMarketOpen }),
          ...(config.overseasMarketClose !== undefined && { overseasMarketClose: config.overseasMarketClose }),
        },
      });
    } else {
      await db.agentConfig.create({
        data: {
          cycleIntervalMs: config.cycleIntervalMs ?? 60000,
          tradeOnlyMarketHours: config.tradeOnlyMarketHours ?? true,
          domesticMarketOpen: config.domesticMarketOpen ?? '08:30',
          domesticMarketClose: config.domesticMarketClose ?? '18:00',
          overseasMarketOpen: config.overseasMarketOpen ?? '23:30',
          overseasMarketClose: config.overseasMarketClose ?? '06:00',
        },
      });
    }

    // 메모리 설정도 업데이트
    schedulerState.config = { ...schedulerState.config, ...config };

    // 스케줄러가 실행 중이면 인터벌 재설정
    if (schedulerState.isSchedulerRunning && config.cycleIntervalMs !== undefined) {
      restartSchedulerInterval();
    }
  } catch (error) {
    console.error('[Scheduler] 설정 저장 실패:', error);
  }
}

/**
 * 스케줄러 인터벌 재시작
 */
function restartSchedulerInterval(): void {
  if (schedulerState.intervalId) {
    clearInterval(schedulerState.intervalId);
  }
  schedulerState.intervalId = setInterval(executeSchedulerCycle, schedulerState.config.cycleIntervalMs);
  console.log(`[Scheduler] 인터벌 재설정: ${schedulerState.config.cycleIntervalMs / 1000}초`);
}

/**
 * 스케줄러 사이클 실행 (서버 사이드)
 * 타임아웃: 최대 120초, 초과 시 에러 카운트 증가
 */
async function executeSchedulerCycle(): Promise<void> {
  if (schedulerState.isCycleRunning) {
    console.log('[Scheduler] 이전 사이클이 아직 실행 중, 스킵');
    return;
  }

  // 장시간 체크 (모의투자 모드에서는 장시간 무관하게 항상 실행)
  if (schedulerState.config.tradeOnlyMarketHours) {
    // KIS 설정이 모의투자인지 확인
    let isDemoMode = false;
    try {
      const kisConfig = await db.kisConfig.findFirst();
      isDemoMode = kisConfig?.isDemo ?? false;
    } catch (e) {}
    
    if (!isDemoMode) {
      // 실전투자: 장시간에만 거래
      const isDomesticOpen = isMarketHours('DOMESTIC');
      const isOverseasOpen = isMarketHours('OVERSEAS');
      const { hours, minutes, dayOfWeek } = getKSTNow();
      const kstTimeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
      const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

      if (!isDomesticOpen && !isOverseasOpen) {
        console.log(`[Scheduler] 장시간 외, 사이클 스킵 (실전투자) - KST ${kstTimeStr} ${dayNames[dayOfWeek]}요일`);
        return;
      }
    } else {
      console.log('[Scheduler] 모의투자 모드: 장시간 무관하게 실행');
    }
  }

  schedulerState.isCycleRunning = true;
  schedulerState.lastCycleStartTime = new Date();

  try {
    console.log('[Scheduler] 에이전트 사이클 실행 시작');

    // 타임아웃 래퍼 (120초)
    const timeoutMs = 120000;
    const result = await Promise.race([
      runAgentCycle(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`사이클 타임아웃 (${timeoutMs / 1000}초)`)), timeoutMs)
      ),
    ]);

    // 성공 시 에러 카운트 리셋
    schedulerState.errorCount = 0;

    // DB에 결과 저장 (비동기, 블로킹하지 않음)
    saveCycleResult(result).catch(() => {});

    console.log(`[Scheduler] 사이클 완료: 분석 ${result.stocksAnalyzed}종목, 신호 ${result.signalsGenerated}개, 주문 ${result.ordersPlaced}건`);
  } catch (error) {
    schedulerState.errorCount++;
    console.error(`[Scheduler] 사이클 실행 실패 (${schedulerState.errorCount}/${MAX_CONSECUTIVE_ERRORS}):`, error);

    // 연속 에러가 너무 많으면 스케줄러 자동 중지
    if (schedulerState.errorCount >= MAX_CONSECUTIVE_ERRORS) {
      console.error('[Scheduler] 연속 에러 한계 도달, 스케줄러 자동 중지');
      stopScheduler().catch(() => {});
    }
  } finally {
    schedulerState.isCycleRunning = false;
  }
}

/**
 * 사이클 결과를 DB에 저장
 */
async function saveCycleResult(result: {
  success: boolean;
  stocksAnalyzed: number;
  signalsGenerated: number;
  ordersPlaced: number;
  positionsMonitored: number;
  exitsExecuted: number;
  errors: string[];
}): Promise<void> {
  try {
    const existing = await db.agentConfig.findFirst();
    if (existing) {
      await db.agentConfig.update({
        where: { id: existing.id },
        data: {
          lastCycleAt: new Date(),
          lastCycleResult: JSON.stringify(result),
          totalCycles: existing.totalCycles + 1,
          totalTrades: existing.totalTrades + result.ordersPlaced,
        },
      });
    }
  } catch (error) {
    console.error('[Scheduler] 결과 저장 실패:', error);
  }
}

/**
 * 서버 사이드 스케줄러 시작
 */
export async function startScheduler(): Promise<{ success: boolean; message: string }> {
  if (schedulerState.isSchedulerRunning) {
    return { success: false, message: '스케줄러가 이미 실행 중입니다.' };
  }

  try {
    // 설정 로드
    await loadSchedulerConfig();

    // 에이전트 시작 (세션 생성)
    const agentResult = await startAgent();
    if (!agentResult.success) {
      return { success: false, message: `에이전트 시작 실패: ${agentResult.message}` };
    }

    // DB에 실행 상태 저장
    const existing = await db.agentConfig.findFirst();
    if (existing) {
      await db.agentConfig.update({
        where: { id: existing.id },
        data: {
          isRunning: true,
          currentSessionId: agentResult.sessionId,
          schedulerMode: 'SERVER',
        },
      });
    } else {
      await db.agentConfig.create({
        data: {
          isRunning: true,
          currentSessionId: agentResult.sessionId,
          schedulerMode: 'SERVER',
          cycleIntervalMs: schedulerState.config.cycleIntervalMs,
          tradeOnlyMarketHours: schedulerState.config.tradeOnlyMarketHours,
          domesticMarketOpen: schedulerState.config.domesticMarketOpen,
          domesticMarketClose: schedulerState.config.domesticMarketClose,
          overseasMarketOpen: schedulerState.config.overseasMarketOpen,
          overseasMarketClose: schedulerState.config.overseasMarketClose,
        },
      });
    }

    // 스케줄러 인터벌 시작
    schedulerState.intervalId = setInterval(executeSchedulerCycle, schedulerState.config.cycleIntervalMs);
    schedulerState.isSchedulerRunning = true;
    schedulerState.startedAt = new Date();
    schedulerState.errorCount = 0;

    // 첫 사이클은 비동기로 실행 (응답을 블로킹하지 않도록)
    // 모의투자 모드에서는 장시간 무관하게 항상 첫 사이클 실행
    let shouldRunFirstCycle = !schedulerState.config.tradeOnlyMarketHours || isMarketHours('ALL');
    if (!shouldRunFirstCycle) {
      try {
        const kisConfig = await db.kisConfig.findFirst();
        if (kisConfig?.isDemo) {
          shouldRunFirstCycle = true; // 모의투자: 장시간 무관
        }
      } catch (e) {}
    }
    if (shouldRunFirstCycle) {
      setTimeout(() => executeSchedulerCycle(), 2000); // 2초 후 비동기 실행
    }

    console.log(`[Scheduler] 서버 스케줄러 시작 (주기: ${schedulerState.config.cycleIntervalMs / 1000}초)`);
    return { success: true, message: `서버 스케줄러가 시작되었습니다. (주기: ${schedulerState.config.cycleIntervalMs / 1000}초)` };
  } catch (error) {
    console.error('[Scheduler] 시작 실패:', error);
    return { success: false, message: `스케줄러 시작 실패: ${error instanceof Error ? error.message : 'Unknown'}` };
  }
}

/**
 * 서버 사이드 스케줄러 중지
 */
export async function stopScheduler(): Promise<{ success: boolean; message: string }> {
  if (!schedulerState.isSchedulerRunning) {
    return { success: false, message: '스케줄러가 실행 중이 아닙니다.' };
  }

  try {
    // 인터벌 정지
    if (schedulerState.intervalId) {
      clearInterval(schedulerState.intervalId);
      schedulerState.intervalId = null;
    }

    // 에이전트 중지
    await stopAgent();

    // DB에 중지 상태 저장
    const existing = await db.agentConfig.findFirst();
    if (existing) {
      await db.agentConfig.update({
        where: { id: existing.id },
        data: {
          isRunning: false,
          currentSessionId: null,
        },
      });
    }

    schedulerState.isSchedulerRunning = false;
    schedulerState.startedAt = null;

    console.log('[Scheduler] 서버 스케줄러 중지');
    return { success: true, message: '서버 스케줄러가 중지되었습니다.' };
  } catch (error) {
    console.error('[Scheduler] 중지 실패:', error);
    return { success: false, message: `스케줄러 중지 실패: ${error instanceof Error ? error.message : 'Unknown'}` };
  }
}

/**
 * 스케줄러 상태 조회
 */
export async function getSchedulerStatus(): Promise<{
  isSchedulerRunning: boolean;
  schedulerMode: string;
  config: SchedulerConfig;
  isCycleRunning: boolean;
  errorCount: number;
  startedAt: Date | null;
  lastCycleAt: Date | null;
  nextCycleAt: Date | null;
  isMarketOpen: { domestic: boolean; overseas: boolean };
  totalCycles: number;
  totalTrades: number;
  currentKST: string;
  domesticSession: DomesticSessionInfo;
}> {
  // DB에서 최신 설정 로드
  const dbConfig = await db.agentConfig.findFirst();

  const lastCycleAt = dbConfig?.lastCycleAt ?? schedulerState.lastCycleStartTime;
  const nextCycleAt = schedulerState.isSchedulerRunning && lastCycleAt
    ? new Date(lastCycleAt.getTime() + schedulerState.config.cycleIntervalMs)
    : null;

  // 현재 KST 시간 문자열 (디버깅용)
  const { hours, minutes, dayOfWeek } = getKSTNow();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const currentKST = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${dayNames[dayOfWeek]}요일`;

  // 현재 국내 거래세션 정보
  const domesticSession = getDomesticSession();

  return {
    isSchedulerRunning: schedulerState.isSchedulerRunning,
    schedulerMode: dbConfig?.schedulerMode ?? 'SERVER',
    config: { ...schedulerState.config },
    isCycleRunning: schedulerState.isCycleRunning,
    errorCount: schedulerState.errorCount,
    startedAt: schedulerState.startedAt,
    lastCycleAt,
    nextCycleAt,
    isMarketOpen: {
      domestic: isMarketHours('DOMESTIC'),
      overseas: isMarketHours('OVERSEAS'),
    },
    totalCycles: dbConfig?.totalCycles ?? 0,
    totalTrades: dbConfig?.totalTrades ?? 0,
    currentKST,
    domesticSession,
  };
}

/**
 * 서버 시작 시 자동 복구
 * DB에 isRunning=true로 저장된 세션이 있으면 스케줄러 자동 재시작
 */
export async function autoRecoverScheduler(): Promise<void> {
  try {
    const config = await db.agentConfig.findFirst();
    if (config?.isRunning && config.schedulerMode === 'SERVER') {
      console.log('[Scheduler] 이전 실행 세션 발견, 자동 복구 시도...');
      const result = await startScheduler();
      if (result.success) {
        console.log('[Scheduler] 자동 복구 성공');
      } else {
        console.error('[Scheduler] 자동 복구 실패:', result.message);
        // 복구 실패 시 DB 상태 리셋
        await db.agentConfig.update({
          where: { id: config.id },
          data: { isRunning: false, currentSessionId: null },
        });
      }
    }
  } catch (error) {
    console.error('[Scheduler] 자동 복구 중 오류:', error);
  }
}

// 서버 시작 시 자동 복구는 API 라우트를 통해 수동 호출
// (모듈 로드 시 자동 실행은 서버 크래시 방지를 위해 제거)
export { autoRecoverScheduler };
