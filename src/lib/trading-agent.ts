// 자동매매 에이전트 코어
// 시그널 생성 → 리스크 체크 → 주문 실행 → 포지션 모니토링 전체 파이프라인
// 국내주식 + 해외주식 지원

import { db } from './db';
import { KisApiClient, normalizeOverseasSymbol } from './kis-api';
import { TradingEngine } from './trading-engine';
import { RiskManager } from './risk-manager';
import { scanTargetStocks } from './market-scanner';
import { aiAnalyzer } from './ai-analyzer';
import { 
  KisConfig, StockCandle, OverseasStockCandle, 
  BalanceItem, OverseasBalanceItem, MarketType,
  OrderRequest, TradingSignal
} from './types';
import { getDomesticSession, getKSTNow, DomesticSession } from './agent-scheduler';
import { getOrCreateKisConfigFromEnv } from './kis-config-loader';
import {
  getEffectiveTradingSettings,
  buildRiskConfigFromSettings,
  formatSettingsSummary,
  computeRuntimeDecision,
  validateOrderExecution,
  EffectiveTradingSettings,
  RuntimeDecision,
} from './effective-settings';

// 에이전트 로그 타입
export interface AgentLog {
  id: string;
  timestamp: Date;
  type: 'INFO' | 'SIGNAL' | 'TRADE' | 'RISK' | 'ERROR' | 'EXIT';
  market: MarketType;
  message: string;
  details?: Record<string, unknown>;
}

// 에이전트 실행 결과
export interface AgentCycleResult {
  success: boolean;
  startTime: Date;
  endTime: Date;
  stocksAnalyzed: number;
  signalsGenerated: number;
  ordersPlaced: number;
  positionsMonitored: number;
  exitsExecuted: number;
  logs: AgentLog[];
  errors: string[];
  // 분석 성공/실패 종목 수
  domesticSuccess: number;
  domesticFailed: number;
  overseasSuccess: number;
  overseasFailed: number;
  // stocksAnalyzed가 0일 때 원인
  zeroAnalysisReason?: string;
  // ── 진단 필드 (status API에서 사용) ──
  uiSignalsCount?: number;
  executableSignalsCount?: number;
  signalsBlockedReasons?: string[];
  topBuyCandidates?: Array<{stockCode: string; stockName: string; confidence: number; signalType: string; blockedReason?: string}>;
  signalThreshold?: number;
  weakSignalThreshold?: number;
  minConfidenceThreshold?: number;
  strategyAggressiveness?: string;
  positionQueryFailed?: boolean;
  positionQueryFailedReason?: string;
  forceTestSignalUsed?: boolean;
}

// 에이전트 상태
export interface AgentStatus {
  isRunning: boolean;
  currentSessionId: string | null;
  lastCycleTime: Date | null;
  lastCycleResult: AgentCycleResult | null;
  totalCycles: number;
  totalTrades: number;
  dailyPnL: number;
  logs: AgentLog[];
}

// 메모리 내 에이전트 상태 (서버 재시작 시 리셋)
let agentState: AgentStatus = {
  isRunning: false,
  currentSessionId: null,
  lastCycleTime: null,
  lastCycleResult: null,
  totalCycles: 0,
  totalTrades: 0,
  dailyPnL: 0,
  logs: [],
};

const MAX_LOGS = 200;

export function addLog(
  type: AgentLog['type'],
  market: MarketType,
  message: string,
  details?: Record<string, unknown>
): AgentLog {
  const log: AgentLog = {
    id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date(),
    type,
    market,
    message,
    details,
  };
  agentState.logs = [log, ...agentState.logs].slice(0, MAX_LOGS);

  // DB에 로그 영속화 (비동기, 실패해도 무시)
  db.agentLog.create({
    data: {
      type,
      market,
      message,
      details: details ? JSON.stringify(details) : null,
      sessionId: agentState.currentSessionId,
    },
  }).catch(() => {});

  return log;
}

/**
 * KIS 설정 로드
 * 공통 모듈(kis-config-loader)을 사용하여 DB + 환경변수 fallback 로드
 * - 1순위: DB에 저장된 설정
 * - 2순위: 환경변수 (KIS_APP_KEY/KIS_APPKEY/APP_KEY 등 fallback 우선순위 적용)
 * - 환경변수에서 로드 시 DB에 자동 저장
 * - 계좌번호 8자리 → 10자리 자동 정규화
 * - App Secret 전체값 로그 미출력, App Key는 앞 4자리만 표시
 */
async function loadKisConfig(): Promise<KisConfig | null> {
  const config = await getOrCreateKisConfigFromEnv();

  if (config) {
    // 에이전트 로그에 기록 (민감정보 마스킹)
    const maskedKey = config.appKey.substring(0, 4) + '****';
    const maskedAccount = config.accountNo.replace(/-/g, '').length > 4
      ? config.accountNo.replace(/-/g, '').substring(0, 2) + '****' + config.accountNo.replace(/-/g, '').slice(-2)
      : '****';
    addLog('INFO', 'DOMESTIC', `KIS 설정 로드 완료 (appKey=${maskedKey}, accountNo=${maskedAccount}, isDemo=${config.isDemo})`);
  } else {
    addLog('INFO', 'DOMESTIC', 'KIS 설정 없음 - 실제 매매 불가 (신호 분석만 수행). 필요 환경변수: KIS_APP_KEY/KIS_APP_SECRET/KIS_ACCOUNT_NO 또는 KIS_ACCOUNT');
  }

  return config;
}

/**
 * 분석 대상 종목 로드
 * 보유종목 + 관심종목 + 우량 대형주 풀 병합 (market-scanner 사용)
 * 중복 자동 제거, 보유종목 우선
 */
async function loadTargetStocks(
  kisClient: KisApiClient | null
): Promise<{
  domestic: Array<{ code: string; name: string }>;
  overseas: Array<{ code: string; name: string; exchange: string }>;
}> {
  const result = await scanTargetStocks(kisClient);
  return {
    domestic: result.domestic,
    overseas: result.overseas,
  };
}

/**
 * 캔들 데이터 조회 (실제 API만 사용, 모의 데이터 사용 안 함)
 * 실패 시 상세 에러 정보를 로그에 남김
 */
async function fetchCandles(
  kisClient: KisApiClient | null,
  stockCode: string,
  stockName: string,
  market: MarketType,
  exchangeCode?: string
): Promise<{ candles: StockCandle[]; error?: string }> {
  // KIS 클라이언트가 없으면 조회 불가
  if (!kisClient) {
    const reason = 'KIS 클라이언트 없음';
    addLog('ERROR', market, `${stockName}(${stockCode}) 캔들 조회 불가 - ${reason}`);
    return { candles: [], error: reason };
  }

  try {
    if (market === 'OVERSEAS' && exchangeCode) {
      const overseasCandles = await kisClient.getOverseasDailyCandles(
        stockCode, exchangeCode, '3M'
      );
      // OverseasStockCandle → StockCandle 변환
      const candles = overseasCandles.map(c => ({
        date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      return { candles };
    } else {
      const candles = await kisClient.getStockDailyCandles(stockCode, '3M');
      return { candles };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    addLog('ERROR', market, `${stockName}(${stockCode}) 캔들 데이터 조회 실패`, {
      stockCode,
      stockName,
      market,
      exchangeCode: exchangeCode || '',
      error: errorMsg,
    });
    return { candles: [], error: errorMsg };
  }
}

/**
 * 현재 포지션 조회
 */
async function fetchPositions(
  kisClient: KisApiClient | null,
  market: MarketType
): Promise<{
  positions: BalanceItem[];
  overseasPositions: OverseasBalanceItem[];
  accountBalance: number;
}> {
  if (!kisClient) {
    return { positions: [], overseasPositions: [], accountBalance: 0 };
  }

  try {
    if (market === 'DOMESTIC') {
      const balance = await kisClient.getAccountBalance();
      return {
        positions: balance.positions,
        overseasPositions: [],
        accountBalance: balance.availableAmount,
      };
    } else {
      const balance = await kisClient.getOverseasAccountBalance();
      // OverseasBalanceItem → BalanceItem 변환 (리스크 매니저용)
      const convertedPositions: BalanceItem[] = balance.positions.map(p => ({
        stockCode: p.stockCode,
        stockName: p.stockName,
        quantity: p.quantity,
        avgPrice: p.avgPrice,
        currentPrice: p.currentPrice,
        profitLoss: p.profitLoss,
        profitRate: p.profitRate,
        evaluationAmount: p.evaluationAmount,
        market: 'OVERSEAS',
        currency: 'USD',
        exchangeCode: p.exchangeCode,
        exchangeRate: p.exchangeRate,
      }));
      return {
        positions: convertedPositions,
        overseasPositions: balance.positions,
        accountBalance: balance.availableAmount,
      };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // KIS API 에러 상세 정보 추출 (rt_cd, msg_cd, msg1 포함 여부 확인)
    const errorDetails: Record<string, unknown> = {
      error: errorMsg,
      market,
    };
    // 에러 메시지에서 KIS 상태코드 파싱 시도
    const rtCdMatch = errorMsg.match(/rt_cd=([^,\)]+)/);
    const msgCdMatch = errorMsg.match(/msg_cd=([^,\)]+)/);
    const msg1Match = errorMsg.match(/msg1=([^,\)]+)/);
    if (rtCdMatch) errorDetails.rt_cd = rtCdMatch[1];
    if (msgCdMatch) errorDetails.msg_cd = msgCdMatch[1];
    if (msg1Match) errorDetails.msg1 = msg1Match[1];

    addLog('ERROR', market, `${market === 'DOMESTIC' ? '국내' : '해외'} 포지션 조회 실패`, errorDetails);
    return { positions: [], overseasPositions: [], accountBalance: 0 };
  }
}

/**
 * 국내 주문 정책 체크
 * 현재 거래세션과 시그널 타입에 따라 주문 허용 여부 결정
 *
 * 규칙:
 * - BUY: 정규장 09:00~15:10만 허용
 * - SELL/RISK_EXIT: 정규장 09:00~15:20만 허용
 * - 시간외: settings.allowAfterHoursTrading이 true일 때만 허용
 *   (DB 저장 설정 > 환경변수 > 기본값 false)
 */
function getDomesticOrderPolicy(
  signal: TradingSignal,
  allowAfterHoursTrading: boolean
): { allowed: boolean; reason: string; session: DomesticSession } {
  const sessionInfo = getDomesticSession();
  const { session } = sessionInfo;

  // 장외: 항상 차단
  if (session === 'CLOSED') {
    return { allowed: false, reason: `장외 시간 (${sessionInfo.label})`, session };
  }

  // 정규장: BUY/SELL 시간 제한
  if (session === 'REGULAR') {
    const { totalMinutes } = getKSTNow();

    if (signal.signalType === 'BUY') {
      // BUY: 09:00~15:10만 허용
      if (totalMinutes >= 540 && totalMinutes <= 910) {
        return { allowed: true, reason: `정규장 매수 허용`, session };
      }
      const curH = Math.floor(totalMinutes / 60);
      const curM = totalMinutes % 60;
      return { allowed: false, reason: `정규장 매수 마감 (15:10 이후, 현재 ${String(curH).padStart(2,'0')}:${String(curM).padStart(2,'0')})`, session };
    }

    // SELL (RISK_EXIT 포함): 09:00~15:20만 허용
    if (signal.signalType === 'SELL') {
      if (totalMinutes >= 540 && totalMinutes <= 920) {
        return { allowed: true, reason: `정규장 매도 허용`, session };
      }
      const curH = Math.floor(totalMinutes / 60);
      const curM = totalMinutes % 60;
      return { allowed: false, reason: `정규장 매도 마감 (15:20 이후, 현재 ${String(curH).padStart(2,'0')}:${String(curM).padStart(2,'0')})`, session };
    }
  }

  // 시간외 세션: 기본 차단, settings.allowAfterHoursTrading이 true인 경우만 허용
  const afterHoursSessions: DomesticSession[] = [
    'PREMARKET_CLOSE', 'OPENING_CALL_AUCTION', 'CLOSING_CALL_AUCTION',
    'POSTMARKET_CLOSE', 'AFTERHOURS_SINGLE',
  ];
  if (afterHoursSessions.includes(session)) {
    if (allowAfterHoursTrading) {
      return { allowed: true, reason: `시간외 거래 허용 (${sessionInfo.label}, allowAfterHoursTrading=true)`, session };
    }
    return { allowed: false, reason: `시간외 거래 차단 (${sessionInfo.label})`, session };
  }

  return { allowed: false, reason: `알 수 없는 세션 (${sessionInfo.label})`, session };
}

/**
 * 주문 실행 및 기록
 * - 리스크 매니저가 계산한 quantity를 실제 주문에 반영
 * - KIS API 주문 실패를 모의 체결로 바꾸지 않음
 * - 국내 주문은 getDomesticOrderPolicy()로 세션별 허용 여부 사전 체크
 * - PENDING: success true 반환, 포지션 DB는 업데이트하지 않음
 * - FILLED: success true 반환, 포지션 DB 업데이트
 */
async function executeOrder(
  kisClient: KisApiClient | null,
  signal: TradingSignal,
  market: MarketType,
  settings: EffectiveTradingSettings,
  exchangeCode?: string,
  quantity: number = 1
): Promise<{ success: boolean; orderNo: string; message: string }> {
  // ── KIS isDemo 확인 ──
  let isDemo = true;
  try {
    const kisConfig = await db.kisConfig.findFirst();
    if (kisConfig) {
      isDemo = kisConfig.isDemo;
    }
  } catch (_e) {
    // DB 조회 실패 시 기본값 유지
  }

  // ── 일일 주문 건수 & 보유 포지션 수 조회 ──
  let dailyOrderCount = 0;
  let openPositions = 0;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    dailyOrderCount = await db.tradeHistory.count({
      where: {
        market,
        tradedAt: { gte: today },
        status: { notIn: ['CANCELLED', 'FAILED'] },
      },
    });
    openPositions = await db.position.count({
      where: { market },
    });
  } catch (_e) {
    // DB 조회 실패 시 0 유지
  }

  // ── 가용금액 ──
  let availableAmount = 0;
  try {
    if (kisClient) {
      if (market === 'DOMESTIC') {
        const balance = await kisClient.getAccountBalance();
        availableAmount = balance.availableAmount;
      } else {
        const balance = await kisClient.getOverseasAccountBalance();
        availableAmount = balance.availableAmount;
      }
    }
  } catch (_e) {
    // 잔고 조회 실패 시 0 유지
  }

  // ── 주문 사전검증 ──
  const validation = validateOrderExecution(
    settings,
    market,
    isDemo,
    signal.price,
    quantity,
    availableAmount,
    dailyOrderCount,
    openPositions,
    'last', // currentPriceField — 해외 검증 로그에서 항상 'last' 사용
    market === 'OVERSEAS' ? signal.priceGapPercent : undefined,
  );

  // 주문 사전검증 로그 (항상 남김)
  addLog('INFO', market, `주문 사전검증: ${signal.stockName} ${signal.signalType}`, {
    market: validation.market,
    tradingMode: validation.tradingMode,
    orderExecutionMode: validation.orderExecutionMode,
    isDemo: validation.isDemo,
    enableOrder: validation.enableOrder,
    allowRealOrder: validation.allowRealOrder,
    killSwitchEnabled: validation.killSwitchEnabled,
    currentPrice: validation.currentPrice,
    currentPriceField: validation.currentPriceField,
    priceGapPercent: validation.priceGapPercent,
    maxPriceGapPercent: validation.maxPriceGapPercent,
    availableAmount: validation.availableAmount,
    calculatedQuantity: validation.calculatedQuantity,
    estimatedOrderAmount: validation.estimatedOrderAmount,
    maxOrderAmount: validation.maxOrderAmount,
    dailyOrderCount: validation.dailyOrderCount,
    maxDailyOrders: validation.maxDailyOrders,
    openPositions: validation.openPositions,
    maxOpenPositions: validation.maxOpenPositions,
    canPlaceOrder: validation.canPlaceOrder,
    blockedReason: validation.blockedReason,
  });

  if (!validation.canPlaceOrder) {
    addLog('RISK', market, `주문 차단: ${validation.blockedReason}`, {
      stockCode: signal.stockCode,
      signalType: signal.signalType,
      strategy: signal.strategy,
      blockedReason: validation.blockedReason,
    });
    return { success: false, orderNo: '', message: `주문 차단: ${validation.blockedReason}` };
  }

  // 해외 주문: 거래소 코드 유효성 (기존 로직 유지)
  if (market === 'OVERSEAS') {
    const validExchanges = ['NAS', 'NYS', 'AMS', 'TKS', 'HKS', 'SHS', 'SZS'];
    if (!exchangeCode || !validExchanges.includes(exchangeCode)) {
      addLog('RISK', market, `해외 주문 차단: 유효하지 않은 거래소 코드 (${exchangeCode || '없음'})`, {
        stockCode: signal.stockCode,
        exchangeCode: exchangeCode || '',
      });
      return { success: false, orderNo: '', message: `해외 주문 차단: 유효하지 않은 거래소 코드 (${exchangeCode || '없음'})` };
    }
    if (quantity <= 0) {
      addLog('RISK', market, `해외 주문 차단: 수량이 0 이하 (${quantity})`, { stockCode: signal.stockCode });
      return { success: false, orderNo: '', message: `해외 주문 차단: 수량이 0 이하 (${quantity})` };
    }
  }

  // 국내 주문: 거래세션 정책 체크 (DB 저장 설정 기반)
  if (market === 'DOMESTIC') {
    const policy = getDomesticOrderPolicy(signal, settings.allowAfterHoursTrading);
    if (!policy.allowed) {
      addLog('RISK', market, `${signal.stockName} 주문 차단: ${policy.reason}`, {
        stockCode: signal.stockCode,
        signalType: signal.signalType,
        strategy: signal.strategy,
        session: policy.session,
      });
      return { success: false, orderNo: '', message: `주문 차단: ${policy.reason}` };
    }
  }

  const safeQuantity = Math.max(1, Math.floor(quantity));
  const orderRequest: OrderRequest = {
    stockCode: signal.stockCode,
    orderType: signal.signalType as 'BUY' | 'SELL',
    quantity: safeQuantity,
    price: signal.price,
    orderKind: '01', // 시장가
    market,
    exchangeCode,
  };

  let orderNo = '';
  let status = 'PENDING';
  let message = '';

  // KIS API로 주문 실행
  if (kisClient) {
    try {
      const result = market === 'OVERSEAS'
        ? await kisClient.placeOverseasOrder(orderRequest)
        : await kisClient.placeOrder(orderRequest);

      orderNo = result.orderNo;
      status = result.status;
      message = result.message;
    } catch (error) {
      orderNo = '';
      status = 'FAILED';
      message = `주문 실패: ${error instanceof Error ? error.message : 'Unknown'}`;
      addLog('ERROR', market, `${signal.stockName} 주문 실패`, {
        error: error instanceof Error ? error.message : String(error),
        stockCode: signal.stockCode,
        quantity: safeQuantity,
        price: signal.price,
      });
    }
  } else {
    // KIS 미설정 상태에서는 주문을 실행하지 않음
    addLog('ERROR', market, 'KIS 클라이언트 없음: 주문 불가', {
      stockCode: signal.stockCode,
      signalType: signal.signalType,
    });
    return { success: false, orderNo: '', message: 'KIS API 미연결: 주문을 실행할 수 없습니다. API 설정을 완료하고 토큰을 발급받으세요.' };
  }

  // 주문 완전 실패 시 종료
  if (status === 'FAILED') {
    return { success: false, orderNo, message };
  }

  // 거래 내역 DB 기록
  try {
    await db.tradeHistory.create({
      data: {
        stockCode: signal.stockCode,
        stockName: signal.stockName,
        tradeType: signal.signalType,
        quantity: safeQuantity,
        price: signal.price,
        totalAmount: signal.price * safeQuantity,
        strategy: signal.strategy,
        signalReason: signal.reason,
        status,
        orderNo,
        market,
        exchangeCode: exchangeCode || null,
        currency: market === 'OVERSEAS' ? 'USD' : 'KRW',
        // 주문 출처 및 실행 모드
        source: 'AGENT',
        orderExecutionMode: settings.orderExecutionMode,
        // 가격 상세
        currentPrice: signal.price, // 주문 직전 실시간 현재가 (signal.price에 이미 반영됨)
        orderPrice: signal.price,
        filledPrice: status === 'FILLED' ? signal.price : null,
        avgFillPrice: status === 'FILLED' ? signal.price : null,
        slippagePercent: null,
        // KIS API 응답 (추후 체결 조회에서 업데이트)
      },
    });
  } catch (dbError) {
    addLog('ERROR', market, '거래 내역 저장 실패', {
      error: dbError instanceof Error ? dbError.message : String(dbError),
    });
  }

  // 포지션 DB 업데이트: status === 'FILLED'일 때만 반영
  if (status === 'FILLED') {
    try {
      if (signal.signalType === 'BUY') {
        const positionId = `${market}-${exchangeCode || 'KR'}-${signal.stockCode}`;
        await db.position.upsert({
          where: {
            id: positionId,
          },
          create: {
            id: positionId,
            stockCode: signal.stockCode,
            stockName: signal.stockName,
            quantity: safeQuantity,
            avgPrice: signal.price,
            currentPrice: signal.price,
            profitLoss: 0,
            profitRate: 0,
            strategy: signal.strategy,
            market,
            exchangeCode: exchangeCode || null,
            currency: market === 'OVERSEAS' ? 'USD' : 'KRW',
          },
          update: {
            quantity: { increment: safeQuantity },
            currentPrice: signal.price,
          },
        });
      } else if (signal.signalType === 'SELL') {
        // 매도 시 포지션 삭제 또는 수량 감소
        const positionId = `${market}-${exchangeCode || 'KR'}-${signal.stockCode}`;
        const existingPos = await db.position.findUnique({
          where: { id: positionId },
        });
        if (existingPos) {
          if (existingPos.quantity <= safeQuantity) {
            await db.position.delete({
              where: { id: positionId },
            });
          } else {
            await db.position.update({
              where: { id: positionId },
              data: {
                quantity: existingPos.quantity - safeQuantity,
                currentPrice: signal.price,
              },
            });
          }
        }
      }
    } catch (posError) {
      addLog('ERROR', market, '포지션 업데이트 실패', {
        error: posError instanceof Error ? posError.message : String(posError),
      });
    }
  }

  // PENDING: success true 반환, 포지션 DB는 업데이트하지 않음
  // FILLED: success true 반환, 포지션 DB 업데이트 완료
  return { success: true, orderNo, message: `주문 접수 (${status}) - ${message}` };
}

/**
 * 포지션 모니토링 - 손절/익절/트레일링스톱 체크
 */
async function monitorPositions(
  kisClient: KisApiClient | null,
  market: MarketType,
  settings: EffectiveTradingSettings
): Promise<number> {
  let exitsExecuted = 0;

  const riskConfig = buildRiskConfigFromSettings(settings, market);
  const riskManager = new RiskManager(riskConfig, market);

  const { positions } = await fetchPositions(kisClient, market);

  for (const position of positions) {
    try {
      // 손절/익절 체크
      const exitCheck = riskManager.checkPositionExit(
        position,
        position.currentPrice,
        position.avgPrice,
        Math.max(position.currentPrice, position.avgPrice * 1.1), // highSinceEntry 추정치
        position.stockCode.startsWith('0') ? 'COMPOSITE' : 'SUPER_TREND' // 시장별 기본 전략
      );

      if (exitCheck.shouldExit) {
        addLog('EXIT', market, 
          `${position.stockName} 자동 청산: ${exitCheck.reason} (현재가: ${position.currentPrice})`,
          { stockCode: position.stockCode, reason: exitCheck.reason, price: position.currentPrice }
        );

        // 매도 주문 실행
        const sellSignal: TradingSignal = {
          stockCode: position.stockCode,
          stockName: position.stockName,
          signalType: 'SELL',
          strategy: 'RISK_EXIT',
          confidence: 90,
          price: position.currentPrice,
          reason: exitCheck.reason,
          indicators: {},
          timestamp: new Date(),
        };

        const result = await executeOrder(
          kisClient,
          sellSignal,
          market,
          settings,
          position.exchangeCode,
          position.quantity
        );

        if (result.success) {
          exitsExecuted++;
          addLog('TRADE', market, 
            `${position.stockName} 청산 주문 접수: ${position.quantity}주 (${result.orderNo})`,
            { orderNo: result.orderNo, quantity: position.quantity, reason: exitCheck.reason }
          );
        }
      }
    } catch (error) {
      addLog('ERROR', market, `${position.stockName} 포지션 모니토링 오류`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return exitsExecuted;
}

/**
 * 포지션 동기화 (Reconciliation)
 * KIS 잔고 API에서 실제 보유 종목을 가져와 로컬 DB와 동기화
 * 주문 후 낙관적 업데이트된 포지션을 실제 잔고 기준으로 보정
 * - 잔고에 있고 DB에 없으면 추가 (이미 보유 중인 종목)
 * - 잔고에 없고 DB에 있으면 삭제 (전량 매도된 종목)
 * - 수량/가격 불일치 시 잔고 기준으로 업데이트
 */
async function reconcilePositions(
  kisClient: KisApiClient | null,
  market: MarketType
): Promise<{ synced: number; added: number; removed: number }> {
  if (!kisClient) return { synced: 0, added: 0, removed: 0 };

  let synced = 0;
  let added = 0;
  let removed = 0;

  try {
    const { positions: actualPositions } = await fetchPositions(kisClient, market);

    // 잔고에 있는 종목 ID 집합
    const actualIds = new Set(
      actualPositions.map(p => `${market}-${p.exchangeCode || 'KR'}-${p.stockCode}`)
    );

    // DB에서 현재 마켓의 포지션 조회
    const dbPositions = await db.position.findMany({
      where: { market },
    });

    // 1. 잔고에 없는 포지션 삭제 (전량 매도 또는 체결 실패)
    for (const dbPos of dbPositions) {
      if (!actualIds.has(dbPos.id)) {
        await db.position.delete({ where: { id: dbPos.id } }).catch(() => {});
        removed++;
        addLog('INFO', market, `포지션 동기화: ${dbPos.stockName} 삭제 (잔고에 없음)`, {
          stockCode: dbPos.stockCode,
        });
      }
    }

    // 2. 잔고에 있는 종목 upsert
    for (const pos of actualPositions) {
      const positionId = `${market}-${pos.exchangeCode || 'KR'}-${pos.stockCode}`;
      const dbPos = dbPositions.find(p => p.id === positionId);

      if (!dbPos) {
        // DB에 없는 새 포지션 (수동 매수 또는 이전 세션에서 보유)
        await db.position.create({
          data: {
            id: positionId,
            stockCode: pos.stockCode,
            stockName: pos.stockName,
            quantity: pos.quantity,
            avgPrice: pos.avgPrice,
            currentPrice: pos.currentPrice,
            profitLoss: pos.profitLoss,
            profitRate: pos.profitRate,
            strategy: 'MANUAL',
            market,
            exchangeCode: pos.exchangeCode || null,
            currency: pos.currency || (market === 'OVERSEAS' ? 'USD' : 'KRW'),
          },
        }).catch(() => {});
        added++;
      } else {
        // 수량/가격 업데이트
        if (dbPos.quantity !== pos.quantity || Math.abs(dbPos.currentPrice - pos.currentPrice) > 0) {
          await db.position.update({
            where: { id: positionId },
            data: {
              quantity: pos.quantity,
              avgPrice: pos.avgPrice,
              currentPrice: pos.currentPrice,
              profitLoss: pos.profitLoss,
              profitRate: pos.profitRate,
            },
          }).catch(() => {});
          synced++;
        }
      }
    }

    if (added > 0 || removed > 0 || synced > 0) {
      addLog('INFO', market, `포지션 동기화 완료: 추가 ${added}, 삭제 ${removed}, 업데이트 ${synced}`, {
        added, removed, synced,
      });
    }
  } catch (error) {
    addLog('ERROR', market, '포지션 동기화 실패', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { synced, added, removed };
}

/**
 * stocksAnalyzed가 0일 때 원인을 진단하여 반환
 */
function diagnoseZeroAnalysis(
  kisConfig: KisConfig | null,
  kisClient: KisApiClient | null,
  domesticStocks: number,
  overseasStocks: number,
  domesticSuccess: number,
  domesticFailed: number,
  candleErrors: string[]
): string {
  const reasons: string[] = [];

  if (!kisConfig) {
    reasons.push('KIS 설정 없음');
  } else if (!kisClient) {
    reasons.push('KIS 토큰 없음 (연결 실패)');
  }

  if (kisClient && domesticStocks > 0 && domesticSuccess === 0 && domesticFailed > 0) {
    reasons.push(`캔들 조회 실패 (${domesticFailed}종목)`);
  }

  if (kisClient && domesticStocks > 0 && domesticFailed === 0 && domesticSuccess === 0) {
    reasons.push('캔들 개수 30개 미만');
  }

  if (domesticStocks === 0 && overseasStocks === 0) {
    reasons.push('분석 대상 종목 없음');
  }

  // 장외 시간 체크
  const session = getDomesticSession();
  if (session.session === 'CLOSED') {
    reasons.push('장외 시간 (주문 차단됨)');
  }

  if (candleErrors.length > 0) {
    reasons.push(`캔들 에러: ${candleErrors.slice(0, 3).join(', ')}${candleErrors.length > 3 ? ` 외 ${candleErrors.length - 3}건` : ''}`);
  }

  return reasons.length > 0 ? reasons.join(' | ') : '원인 불명';
}

/**
 * 에이전트 1사이클 실행
 * 시그널 분석 → 리스크 체크 → 주문 실행 → 포지션 모니토링
 */
export async function runAgentCycle(): Promise<AgentCycleResult> {
  const startTime = new Date();
  const errors: string[] = [];
  let stocksAnalyzed = 0;
  let signalsGenerated = 0;
  let ordersPlaced = 0;
  let positionsMonitored = 0;
  let exitsExecuted = 0;

  // 분석 성공/실패 카운트
  let domesticSuccess = 0;
  let domesticFailed = 0;
  let overseasSuccess = 0;
  let overseasFailed = 0;
  const candleErrors: string[] = [];

  addLog('INFO', 'DOMESTIC', '자동 분석 사이클 시작');

  // 0. DB 저장 설정 로드 (DB > 환경변수 > 안전 기본값)
  const { settings: effectiveSettings, source: settingsSource } = await getEffectiveTradingSettings();
  const runtime = computeRuntimeDecision(effectiveSettings);

  addLog('INFO', 'DOMESTIC', `실행 설정 로드 완료 (source=${settingsSource}): ${formatSettingsSummary(effectiveSettings)}`);
  addLog('INFO', 'DOMESTIC', `런타임 판단: 분석=${runtime.canRunAnalysisNow ? '허용' : '차단(' + runtime.analysisBlockedReason + ')'}, 국내주문=${runtime.canPlaceDomesticOrderNow ? '허용' : '차단(' + runtime.domesticOrderBlockedReason + ')'}, 해외주문=${runtime.canPlaceOverseasOrderNow ? '허용' : '차단(' + runtime.overseasOrderBlockedReason + ')'}`);

  // autoAnalysisEnabled=false면 분석 자체를 건너뜀
  if (!effectiveSettings.autoAnalysisEnabled) {
    addLog('INFO', 'DOMESTIC', '자동 분석 비활성화 (autoAnalysisEnabled=false), 사이클 건너뜀');
    const endTime = new Date();
    return {
      success: true, startTime, endTime,
      stocksAnalyzed: 0, signalsGenerated: 0, ordersPlaced: 0,
      positionsMonitored: 0, exitsExecuted: 0, logs: agentState.logs.slice(0, 10), errors: [],
      domesticSuccess: 0, domesticFailed: 0, overseasSuccess: 0, overseasFailed: 0,
      zeroAnalysisReason: 'autoAnalysisEnabled=false',
    };
  }

  // runAnalysisOnlyDuringMarketHours=true + 장외면 분석 건너뜀
  if (effectiveSettings.runAnalysisOnlyDuringMarketHours) {
    const domesticOpen = getDomesticSession().session === 'REGULAR';
    if (!domesticOpen) {
      addLog('INFO', 'DOMESTIC', `분석 차단: runAnalysisOnlyDuringMarketHours=true + 장외`);
      const endTime = new Date();
      return {
        success: true, startTime, endTime,
        stocksAnalyzed: 0, signalsGenerated: 0, ordersPlaced: 0,
        positionsMonitored: 0, exitsExecuted: 0, logs: agentState.logs.slice(0, 10), errors: [],
        domesticSuccess: 0, domesticFailed: 0, overseasSuccess: 0, overseasFailed: 0,
        zeroAnalysisReason: 'runAnalysisOnlyDuringMarketHours + 장외',
      };
    }
  }

  // 1. KIS 설정 로드
  const kisConfig = await loadKisConfig();
  let kisClient: KisApiClient | null = null;

  if (kisConfig) {
    try {
      kisClient = new KisApiClient(kisConfig);
      await kisClient.ensureToken();
      addLog('INFO', 'DOMESTIC', 'KIS API 연결 성공');
      
      // 토큰 갱신 내용을 DB에도 업데이트 (getTokenInfo 공식 메서드 사용)
      const tokenInfo = kisClient.getTokenInfo();
      if (tokenInfo.accessToken && tokenInfo.tokenExpiresAt) {
        const configRecord = await db.kisConfig.findFirst();
        if (configRecord) {
          await db.kisConfig.update({
            where: { id: configRecord.id },
            data: {
              accessToken: tokenInfo.accessToken,
              tokenExpiresAt: tokenInfo.tokenExpiresAt,
            },
          });
        }
      }
    } catch (error) {
      addLog('ERROR', 'DOMESTIC', 'KIS API 연결 실패 - 실제 매매 불가', {
        error: error instanceof Error ? error.message : String(error),
      });
      kisClient = null;
    }
  } else {
    addLog('INFO', 'DOMESTIC', 'KIS 설정 없음 - 실제 매매 불가 (신호 분석만 수행)');
  }

  // 2. 분석 대상 종목 로드 (보유종목 + 관심종목 + 우량 대형주)
  const { domestic: domesticStocks, overseas: overseasStocks } = await loadTargetStocks(kisClient);
  addLog('INFO', 'DOMESTIC', `분석 대상: 국내 ${domesticStocks.length}개, 해외 ${overseasStocks.length}개`);

  // 3. 리스크 매니저 초기화 (DB 저장 리스크 설정 + strategyAggressiveness 기반 신뢰도 임계값)
  const domesticRisk = new RiskManager(
    buildRiskConfigFromSettings(effectiveSettings, 'DOMESTIC'),
    'DOMESTIC',
    effectiveSettings.minConfidenceThreshold,
  );
  const overseasRisk = new RiskManager(
    buildRiskConfigFromSettings(effectiveSettings, 'OVERSEAS'),
    'OVERSEAS',
    effectiveSettings.minConfidenceThreshold,
  );

  addLog('INFO', 'DOMESTIC', `전략 공격성: ${effectiveSettings.strategyAggressiveness} (signalThreshold=${effectiveSettings.signalThreshold}, weakThreshold=${effectiveSettings.weakSignalThreshold}, minConfidence=${effectiveSettings.minConfidenceThreshold}%)`);

  // ── 진단 추적용 상태 ──
  let uiSignalsCount = 0;          // TradingEngine이 생성한 BUY/SELL 신호 수 (HOLD 제외)
  let executableSignalsCount = 0;  // 리스크 매니저 통과한 실행 가능 신호 수
  const signalsBlockedReasons: string[] = [];  // 신호 차단 사유 수집
  const topBuyCandidates: Array<{stockCode: string; stockName: string; confidence: number; signalType: string; blockedReason?: string}> = [];

  // ── FORCE_TEST_SIGNAL ──
  // PAPER 모드에서 주문 파이프라인 검증용: 1개 BUY 신호 강제 주입
  // LIVE/REAL 모드에서는 절대 활성화 불가
  const FORCE_TEST_SIGNAL = process.env.FORCE_TEST_SIGNAL === 'true' && effectiveSettings.orderExecutionMode === 'PAPER';
  if (FORCE_TEST_SIGNAL) {
    if (effectiveSettings.orderExecutionMode === 'LIVE' || effectiveSettings.tradingMode === 'REAL') {
      addLog('RISK', 'DOMESTIC', 'FORCE_TEST_SIGNAL은 LIVE/REAL 모드에서 사용할 수 없습니다. 무시됩니다.');
    } else {
      addLog('RISK', 'DOMESTIC', '⚠️ FORCE_TEST_SIGNAL 활성화: 파이프라인 검증용 1회 소액 주문이 실행될 수 있습니다', {
        orderExecutionMode: effectiveSettings.orderExecutionMode,
        maxDomesticOrderAmount: effectiveSettings.maxDomesticOrderAmount,
      });
    }
  }
  let forceTestSignalUsed = false;

  // 4. 현재 포지션 조회
  const domesticPositions = await fetchPositions(kisClient, 'DOMESTIC');

  // ── 포지션 조회 실패 감지 ──
  // KIS 클라이언트가 있는데도 잔고/포지션이 0이면 조회 실패 가능성
  // PAPER+DEMO 모드에서는 주문 차단하지 않음 (소액 주문 검증이 목적)
  let positionQueryFailed = false;
  let positionQueryFailedReason = '';
  if (kisClient && domesticPositions.positions.length === 0 && domesticPositions.accountBalance === 0) {
    positionQueryFailed = true;
    const isPaperDemo = effectiveSettings.orderExecutionMode === 'PAPER' && effectiveSettings.tradingMode === 'DEMO';
    if (isPaperDemo) {
      positionQueryFailedReason = '국내 포지션/잔고 조회 결과 0 (PAPER+DEMO: 소액 주문 허용)';
      addLog('RISK', 'DOMESTIC', `⚠️ ${positionQueryFailedReason}`, {
        positionsCount: domesticPositions.positions.length,
        accountBalance: domesticPositions.accountBalance,
        hasKisClient: !!kisClient,
        orderExecutionMode: effectiveSettings.orderExecutionMode,
        note: 'PAPER 모의투자에서는 잔고 조회 실패해도 maxDomesticOrderAmount 이하 주문 허용',
      });
    } else {
      positionQueryFailedReason = '국내 포지션/잔고 조회 결과가 0 — KIS API 연결 문제 가능성';
      addLog('RISK', 'DOMESTIC', `⚠️ ${positionQueryFailedReason}`, {
        positionsCount: domesticPositions.positions.length,
        accountBalance: domesticPositions.accountBalance,
        hasKisClient: !!kisClient,
      });
    }
  }

  // ========================================
  // 국내주식 분석 & 매매
  // ========================================
  addLog('INFO', 'DOMESTIC', '국내주식 분석 시작');

  for (const stock of domesticStocks) {
    try {
      // 캔들 데이터 조회
      const { candles, error: candleError } = await fetchCandles(kisClient, stock.code, stock.name, 'DOMESTIC');

      if (candleError) {
        domesticFailed++;
        candleErrors.push(`${stock.name}: ${candleError}`);
        // 실패해도 다음 종목으로 계속
        continue;
      }

      if (candles.length < 30) {
        domesticFailed++;
        addLog('INFO', 'DOMESTIC', `${stock.name} 데이터 부족 (캔들 ${candles.length}개, 최소 30개 필요)`, {
          stockCode: stock.code,
          candlesLength: candles.length,
          lastClose: candles.length > 0 ? candles[candles.length - 1].close : null,
        });
        continue;
      }

      domesticSuccess++;
      stocksAnalyzed++;

      // 전략 분석 (strategyAggressiveness 기반 동적 임계값 적용)
      const signal = TradingEngine.analyze(
        candles, stock.code, stock.name, 'ALL', 'DOMESTIC',
        {}, // userParams
        effectiveSettings.signalThreshold,
        effectiveSettings.weakSignalThreshold,
      );

      // 종목별 상세 정보 로그
      addLog('INFO', 'DOMESTIC', `${stock.name} 분석 결과: ${signal.signalType} (신뢰도: ${signal.confidence}%)`, {
        stockCode: stock.code,
        candlesLength: candles.length,
        lastClose: candles[candles.length - 1].close,
        signalType: signal.signalType,
        strategy: signal.strategy,
        signalThreshold: effectiveSettings.signalThreshold,
        weakSignalThreshold: effectiveSettings.weakSignalThreshold,
      });

      // BUY/SELL 후보 추적 (진단용)
      if (signal.signalType !== 'HOLD') {
        uiSignalsCount++;
        topBuyCandidates.push({
          stockCode: stock.code,
          stockName: stock.name,
          confidence: signal.confidence,
          signalType: signal.signalType,
        });
      }

      // ── FORCE_TEST_SIGNAL: 첫 번째 BUY 후보에 강제 BUY 주입 ──
      if (FORCE_TEST_SIGNAL && !forceTestSignalUsed && signal.signalType === 'HOLD' && domesticStocks.indexOf(stock) === 0) {
        // 첫 번째 종목에 대해 강제 BUY 신호 주입
        const forcedSignal: TradingSignal = {
          stockCode: stock.code,
          stockName: stock.name,
          signalType: 'BUY',
          strategy: 'FORCE_TEST',
          confidence: effectiveSettings.minConfidenceThreshold,  // 최소 신뢰도로 설정
          price: signal.price,
          reason: `FORCE_TEST_SIGNAL 파이프라인 검증 (원래: ${signal.signalType}, 신뢰도: ${signal.confidence}%)`,
          indicators: { ...signal.indicators, forceTest: 1 },
          timestamp: new Date(),
        };
        // signal을 강제 BUY로 교체
        Object.assign(signal, forcedSignal);
        forceTestSignalUsed = true;
        addLog('SIGNAL', 'DOMESTIC', `⚠️ FORCE_TEST_SIGNAL: ${stock.name} 강제 BUY 신호 주입 (파이프라인 검증용)`, {
          stockCode: stock.code,
          originalSignalType: 'HOLD',
          originalConfidence: signal.confidence,
          forcedConfidence: effectiveSettings.minConfidenceThreshold,
        });
      }

      if (signal.signalType !== 'HOLD') {
        signalsGenerated++;
        addLog('SIGNAL', 'DOMESTIC', 
          `${stock.name} ${signal.signalType} 신호 (신뢰도: ${signal.confidence}%) - ${signal.reason}`,
          { signalType: signal.signalType, confidence: signal.confidence, price: signal.price, strategy: signal.strategy }
        );

        // AI 분석으로 신호 검증 (비동기, 실패 시 기술적 신호만 사용)
        let finalSignal = signal;
        try {
          const aiResult = await aiAnalyzer.analyzeStock(
            stock.name, stock.code, 'DOMESTIC', signal
          );
          if (aiResult.confidence > 0) {
            finalSignal = aiAnalyzer.combineSignals(signal, aiResult);
            addLog('SIGNAL', 'DOMESTIC',
              `${stock.name} AI 검증: ${signal.signalType}→${finalSignal.signalType} (신뢰도: ${signal.confidence}%→${finalSignal.confidence}%) - AI심리: ${aiResult.sentiment}`,
              { aiRecommendation: aiResult.recommendation, aiConfidence: aiResult.confidence, aiRiskLevel: aiResult.riskLevel }
            );
          }
        } catch (aiError) {
          // AI 분석 실패는 무시하고 기술적 신호만 사용
          addLog('INFO', 'DOMESTIC', `${stock.name} AI 분석 스킵 (기술적 신호만 사용)`);
        }

        // AI 검증 후 HOLD로 변경된 경우 매매 차단
        if (finalSignal.signalType === 'HOLD') {
          addLog('RISK', 'DOMESTIC', `${stock.name} AI 검증 결과 HOLD로 변경 - 매매 차단`);
          continue;
        }

        // 리스크 체크
        const riskCheck = domesticRisk.canTrade(
          finalSignal, domesticPositions.positions, domesticPositions.accountBalance
        );

        if (riskCheck.allowed) {
          executableSignalsCount++;

          // 자동 국내 주문 허용 여부 체크
          if (!effectiveSettings.autoDomesticOrderEnabled) {
            signalsBlockedReasons.push(`${stock.name}: autoDomesticOrderEnabled=false`);
            addLog('RISK', 'DOMESTIC',
              `국내 주문 차단: autoDomesticOrderEnabled=false - ${stock.name} ${finalSignal.signalType} 신호 생성만 수행`,
              { stockCode: stock.code, signalType: finalSignal.signalType, price: finalSignal.price }
            );
            continue;
          }

          // 포지션 사이즈 계산
          const quantity = domesticRisk.calculatePositionSize(
            domesticPositions.accountBalance, finalSignal.price, finalSignal.confidence
          );

          // 주문 실행
          const result = await executeOrder(kisClient, { ...finalSignal, price: finalSignal.price }, 'DOMESTIC', effectiveSettings, undefined, quantity);

          if (result.success) {
            ordersPlaced++;
            addLog('TRADE', 'DOMESTIC',
              `${stock.name} ${finalSignal.signalType} 주문 접수: ${quantity}주 @ ${finalSignal.price}원 (${result.orderNo})`,
              { orderNo: result.orderNo, quantity, price: finalSignal.price }
            );
          } else {
            addLog('ERROR', 'DOMESTIC',
              `${stock.name} ${finalSignal.signalType} 주문 실패: ${result.message}`,
              { orderNo: result.orderNo, quantity, price: finalSignal.price }
            );
          }
        } else {
          signalsBlockedReasons.push(`${stock.name}: ${riskCheck.reason}`);
          // 차단 사유를 후보에도 기록
          const candidate = topBuyCandidates.find(c => c.stockCode === stock.code);
          if (candidate) candidate.blockedReason = riskCheck.reason;
          addLog('RISK', 'DOMESTIC',
            `${stock.name} 매매 차단: ${riskCheck.reason}`,
            { reason: riskCheck.reason }
          );
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`국내 ${stock.name}: ${errMsg}`);
      domesticFailed++;
      addLog('ERROR', 'DOMESTIC', `${stock.name} 분석 오류: ${errMsg}`);
      // 개별 종목 오류가 전체 사이클을 죽이지 않음
    }
  }

  addLog('INFO', 'DOMESTIC', `국내 분석 결과: 성공 ${domesticSuccess}종목, 실패 ${domesticFailed}종목, 주문=${runtime.canPlaceDomesticOrderNow ? '허용' : '차단(' + runtime.domesticOrderBlockedReason + ')'}`, {
    domesticSuccess,
    domesticFailed,
    domesticOrderAllowed: runtime.canPlaceDomesticOrderNow,
  });

  // ========================================
  // 해외주식 분석 & 매매 (DB 저장 설정 기반)
  // ========================================
  if (effectiveSettings.enableOverseasAnalysis) {
    addLog('INFO', 'OVERSEAS', `해외주식 분석 시작 (주문=${runtime.canPlaceOverseasOrderNow ? '허용' : '차단(' + runtime.overseasOrderBlockedReason + ')'})`);

    const overseasPositions = await fetchPositions(kisClient, 'OVERSEAS');

    for (const stock of overseasStocks) {
      try {
        // 해외 종목코드 정규화 (SYMB에 "NAS:RKLB" 전체가 들어가지 않도록)
        const { exchangeCode: normExchange, symbol: normalizedSymbol, displayCode } = normalizeOverseasSymbol(stock.code, stock.exchange);

        const { candles, error: candleError } = await fetchCandles(kisClient, stock.code, stock.name, 'OVERSEAS', stock.exchange);

        if (candleError) {
          overseasFailed++;
          candleErrors.push(`해외 ${stock.name}: ${candleError}`);
          continue;
        }

        if (candles.length < 30) {
          overseasFailed++;
          addLog('INFO', 'OVERSEAS', `${stock.name} 데이터 부족 (캔들 ${candles.length}개)`, {
            stockCode: stock.code,
            normalizedSymbol,
            exchangeCode: normExchange,
            candlesLength: candles.length,
            lastClose: candles.length > 0 ? candles[candles.length - 1].close : null,
          });
          continue;
        }

        overseasSuccess++;
        stocksAnalyzed++;

        // 분석 기준가격 = 마지막 일봉 종가
        const analysisPrice = candles[candles.length - 1].close;

        // 해외 현재가 실시간 조회 (분석과 주문 사이 괴리 추적)
        let currentPriceInfo: {
          stockCode: string;
          originalStockCode: string;
          exchangeCode: string;
          normalizedSymbol: string;
          currentPrice: number;
          currentPriceField: string;
          rawPriceFields: {
            last: unknown;
            base: unknown;
            high: unknown;
            low: unknown;
          };
          previousClose: number;
          highPrice: number;
          lowPrice: number;
          volume: number;
          currency: string;
          timestamp: string;
          source: string;
        } | null = null;
        let currentPrice = 0;
        let priceGapPercent = 0;
        let currentPriceTimestamp = '';
        let priceDataSource = 'daily_candle';

        if (kisClient) {
          try {
            currentPriceInfo = await kisClient.getOverseasCurrentPrice(stock.code, stock.exchange);
            currentPrice = currentPriceInfo.currentPrice;
            currentPriceTimestamp = currentPriceInfo.timestamp;
            priceDataSource = 'daily_candle+current_price';

            // 괴리율 계산
            if (analysisPrice > 0 && currentPrice > 0) {
              priceGapPercent = Math.abs(currentPrice - analysisPrice) / analysisPrice;
            }

            // 괴리율 5% 이상 경고 로그 (RISK 타입)
            if (priceGapPercent >= 0.05) {
              addLog('RISK', 'OVERSEAS',
                `해외 현재가 괴리율 경고: ${currentPriceInfo.normalizedSymbol || normalizedSymbol} gap=${(priceGapPercent * 100).toFixed(2)}%`,
                {
                  originalStockCode: currentPriceInfo.originalStockCode || stock.code,
                  stockCode: currentPriceInfo.stockCode || stock.code,
                  exchangeCode: currentPriceInfo.exchangeCode || normExchange,
                  normalizedSymbol: currentPriceInfo.normalizedSymbol || normalizedSymbol,
                  analysisPrice,
                  currentPrice: currentPriceInfo.currentPrice,
                  priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
                  rawPriceFields: currentPriceInfo.rawPriceFields,
                  currentPriceField: currentPriceInfo.currentPriceField || 'last',
                  currentPriceTimestamp: currentPriceInfo.timestamp,
                  source: currentPriceInfo.source || 'KIS_REST',
                }
              );
            }

            addLog('INFO', 'OVERSEAS',
              `[미] ${stock.name} 해외 현재가 조회 성공: ${currentPriceInfo.normalizedSymbol || normalizedSymbol}, currentPrice=${currentPriceInfo.currentPrice}, timestamp=${currentPriceInfo.timestamp}`,
              {
                originalStockCode: currentPriceInfo.originalStockCode || stock.code,
                stockCode: currentPriceInfo.stockCode || stock.code,
                exchangeCode: currentPriceInfo.exchangeCode || normExchange,
                normalizedSymbol: currentPriceInfo.normalizedSymbol || normalizedSymbol,
                rawPriceFields: currentPriceInfo.rawPriceFields,
                currentPriceField: currentPriceInfo.currentPriceField || 'last',
                currentPrice: currentPriceInfo.currentPrice,
                previousClose: currentPriceInfo.previousClose,
                volume: currentPriceInfo.volume,
                analysisPrice,
                priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
                currentPriceTimestamp: currentPriceInfo.timestamp,
                source: currentPriceInfo.source || 'KIS_REST',
              }
            );
          } catch (cpError) {
            addLog('ERROR', 'OVERSEAS',
              `${stock.name} 해외 현재가 조회 실패: ${cpError instanceof Error ? cpError.message : 'Unknown'}`,
              { stockCode: stock.code, normalizedSymbol, exchangeCode: normExchange }
            );
            // 현재가 조회 실패해도 일봉 분석은 계속 진행
          }
        }

        // 전략 분석 (strategyAggressiveness 기반 동적 임계값 적용)
        const signal = TradingEngine.analyze(
          candles, stock.code, stock.name, 'ALL', 'OVERSEAS',
          {}, // userParams
          effectiveSettings.signalThreshold,
          effectiveSettings.weakSignalThreshold,
        );

        // 분석가/현재가 정보를 시그널에 기록
        signal.analysisPrice = analysisPrice;
        signal.currentPrice = currentPrice;
        signal.priceGapPercent = priceGapPercent;
        signal.currentPriceTimestamp = currentPriceTimestamp;
        signal.dataSource = priceDataSource;

        const gapDisplay = currentPrice > 0
          ? `, currentPrice=${currentPrice}, gap=${(priceGapPercent * 100).toFixed(2)}%`
          : '';
        addLog('INFO', 'OVERSEAS',
          `${stock.name} 분석 결과: ${signal.signalType} (신뢰도: ${signal.confidence}%), normalizedSymbol=${normalizedSymbol}, candles=${candles.length}, lastDailyClose=${analysisPrice}${gapDisplay}, source=${priceDataSource}`,
          {
            originalStockCode: currentPriceInfo?.originalStockCode || stock.code,
            stockCode: currentPriceInfo?.stockCode || stock.code,
            exchangeCode: normExchange,
            normalizedSymbol,
            candlesLength: candles.length,
            lastDailyClose: analysisPrice,
            currentPrice,
            priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
            currentPriceTimestamp,
            rawPriceFields: currentPriceInfo?.rawPriceFields,
            currentPriceField: currentPriceInfo?.currentPriceField || 'last',
            dataSource: priceDataSource,
            realtimeEnabled: false,
            signalType: signal.signalType,
            strategy: signal.strategy,
          }
        );

        if (signal.signalType !== 'HOLD') {
          signalsGenerated++;
          addLog('SIGNAL', 'OVERSEAS',
            `${stock.name} ${signal.signalType} 신호 (신뢰도: ${signal.confidence}%) - ${signal.reason}`,
            { signalType: signal.signalType, confidence: signal.confidence, price: signal.price, strategy: signal.strategy }
          );

          // AI 분석으로 신호 검증
          let finalSignal = signal;
          try {
            const aiResult = await aiAnalyzer.analyzeStock(
              stock.name, stock.code, 'OVERSEAS', signal
            );
            if (aiResult.confidence > 0) {
              finalSignal = aiAnalyzer.combineSignals(signal, aiResult);
              addLog('SIGNAL', 'OVERSEAS',
                `${stock.name} AI 검증: ${signal.signalType}→${finalSignal.signalType} (신뢰도: ${signal.confidence}%→${finalSignal.confidence}%) - AI심리: ${aiResult.sentiment}`,
                { aiRecommendation: aiResult.recommendation, aiConfidence: aiResult.confidence, aiRiskLevel: aiResult.riskLevel }
              );
            }
          } catch (aiError) {
            addLog('INFO', 'OVERSEAS', `${stock.name} AI 분석 스킵 (기술적 신호만 사용)`);
          }

          if (finalSignal.signalType === 'HOLD') {
            addLog('RISK', 'OVERSEAS', `${stock.name} AI 검증 결과 HOLD로 변경 - 매매 차단`);
            continue;
          }

          // 해외 주문 OFF → 신호 생성만, 주문 차단
          if (!effectiveSettings.enableOverseasOrder) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: enableOverseasOrder=false`,
              { stockCode: stock.code, signalType: finalSignal.signalType, price: finalSignal.price }
            );
            continue;
          }

          // ── 해외 가격 괴리율 안전장치 ──
          const maxGap = effectiveSettings.maxOverseasPriceGapPercent;

          // (A) currentPrice <= 0 → 주문 차단
          if (currentPrice <= 0) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: 현재가 조회 불가 (currentPrice=${currentPrice})`,
              { stockCode: stock.code, signalType: finalSignal.signalType }
            );
            continue;
          }

          // (B) analysisPrice <= 0 → 주문 차단
          if (analysisPrice <= 0) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: 분석 기준가 불가 (analysisPrice=${analysisPrice})`,
              { stockCode: stock.code, signalType: finalSignal.signalType }
            );
            continue;
          }

          // (C) 괴리율 초과 → 주문 차단
          if (priceGapPercent > maxGap) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: 분석가와 현재가 괴리율 초과 (gap=${(priceGapPercent * 100).toFixed(2)}% > max=${(maxGap * 100).toFixed(2)}%)`,
              {
                stockCode: stock.code,
                signalType: finalSignal.signalType,
                analysisPrice,
                currentPrice,
                priceGapPercent: parseFloat((priceGapPercent * 100).toFixed(4)),
                maxOverseasPriceGapPercent: maxGap,
              }
            );
            continue;
          }

          // ── 주문 직전 현재가 재조회 ──
          // enableOverseasOrder=true일 때 주문 직전에 최신 가격으로 재검증
          let orderPrice = currentPrice; // 기본: 분석 시점 현재가
          try {
            const recheckPrice = await kisClient!.getOverseasCurrentPrice(stock.code, stock.exchange);
            const recheckCurrentPrice = recheckPrice.currentPrice;
            const recheckTimestamp = recheckPrice.timestamp;

            if (recheckCurrentPrice <= 0) {
              addLog('RISK', 'OVERSEAS',
                `해외 주문 차단: 주문 직전 현재가 재조회 실패 (currentPrice=${recheckCurrentPrice})`,
                { stockCode: stock.code, signalType: finalSignal.signalType }
              );
              continue;
            }

            // 재조회 가격으로 괴리율 재계산
            const recheckGap = analysisPrice > 0
              ? Math.abs(recheckCurrentPrice - analysisPrice) / analysisPrice
              : 1;

            if (recheckGap > maxGap) {
              addLog('RISK', 'OVERSEAS',
                `해외 주문 차단: 주문 직전 괴리율 초과 (gap=${(recheckGap * 100).toFixed(2)}% > max=${(maxGap * 100).toFixed(2)}%)`,
                {
                  stockCode: stock.code,
                  signalType: finalSignal.signalType,
                  analysisPrice,
                  currentPrice: recheckCurrentPrice,
                  priceGapPercent: parseFloat((recheckGap * 100).toFixed(4)),
                  recheckTimestamp,
                }
              );
              continue;
            }

            orderPrice = recheckCurrentPrice;
            addLog('INFO', 'OVERSEAS',
              `${stock.name} 주문 직전 현재가 재조회: $${recheckCurrentPrice} (gap=${(recheckGap * 100).toFixed(2)}%)`,
              { stockCode: stock.code, currentPrice: recheckCurrentPrice, analysisPrice, recheckGap, recheckTimestamp }
            );
          } catch (recheckError) {
            addLog('RISK', 'OVERSEAS',
              `해외 주문 차단: 주문 직전 현재가 재조회 실패`,
              { stockCode: stock.code, error: recheckError instanceof Error ? recheckError.message : 'Unknown' }
            );
            continue;
          }

          // 리스크 체크 (currentPrice 기준)
          const riskSignal = { ...finalSignal, price: orderPrice };
          const riskCheck = overseasRisk.canTrade(
            riskSignal, overseasPositions.positions, overseasPositions.accountBalance
          );

          if (riskCheck.allowed) {
            // 주문 수량은 현재가 기준으로 재계산 (일봉 종가/signal.price 사용 금지)
            const quantity = overseasRisk.calculatePositionSize(
              overseasPositions.accountBalance, orderPrice, finalSignal.confidence
            );

            if (quantity <= 0) {
              addLog('RISK', 'OVERSEAS',
                `해외 주문 차단: 수량 계산 결과 0 이하 (price=$${orderPrice}, balance=${overseasPositions.accountBalance})`,
                { stockCode: stock.code, orderPrice, accountBalance: overseasPositions.accountBalance }
              );
              continue;
            }

            const result = await executeOrder(kisClient, { ...finalSignal, price: orderPrice }, 'OVERSEAS', effectiveSettings, stock.exchange, quantity);

            if (result.success) {
              ordersPlaced++;
              addLog('TRADE', 'OVERSEAS',
                `${stock.name} ${finalSignal.signalType} 주문 접수: ${quantity}주 @ $${orderPrice} (${result.orderNo})`,
                { orderNo: result.orderNo, quantity, price: orderPrice, exchange: stock.exchange, analysisPrice, currentPrice: orderPrice }
              );
            } else {
              addLog('ERROR', 'OVERSEAS',
                `${stock.name} ${finalSignal.signalType} 주문 실패: ${result.message}`,
                { orderNo: result.orderNo, quantity, price: orderPrice, exchange: stock.exchange }
              );
            }
          } else {
            addLog('RISK', 'OVERSEAS',
              `${stock.name} 매매 차단: ${riskCheck.reason}`,
              { reason: riskCheck.reason }
            );
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        errors.push(`해외 ${stock.name}: ${errMsg}`);
        overseasFailed++;
        addLog('ERROR', 'OVERSEAS', `${stock.name} 분석 오류: ${errMsg}`);
      }
    }

    addLog('INFO', 'OVERSEAS', `해외 분석 결과: 성공 ${overseasSuccess}종목, 실패 ${overseasFailed}종목`, {
      overseasSuccess,
      overseasFailed,
    });
  } else {
    addLog('INFO', 'OVERSEAS', '해외주식 분석 건너뜀 (enableOverseasAnalysis=false, 신호 생성만 수행 안 함)');
  }

  // ========================================
  // 포지션 동기화 (Reconciliation)
  // ========================================
  if (kisClient) {
    addLog('INFO', 'DOMESTIC', '포지션 동기화 시작 (잔고 기준)');
    await reconcilePositions(kisClient, 'DOMESTIC');
    if (effectiveSettings.enableOverseasAnalysis) {
      await reconcilePositions(kisClient, 'OVERSEAS');
    }
  }

  // ========================================
  // 포지션 모니토링 (손절/익절/트레일링스톱)
  // ========================================
  addLog('INFO', 'DOMESTIC', '포지션 모니터링 시작');
  
  const domesticExits = await monitorPositions(kisClient, 'DOMESTIC', effectiveSettings);
  const overseasExits = effectiveSettings.enableOverseasAnalysis ? await monitorPositions(kisClient, 'OVERSEAS', effectiveSettings) : 0;
  exitsExecuted = domesticExits + overseasExits;
  positionsMonitored = domesticPositions.positions.length + (effectiveSettings.enableOverseasAnalysis ? (await fetchPositions(kisClient, 'OVERSEAS')).positions.length : 0);

  // ========================================
  // 세션 업데이트
  // ========================================
  if (agentState.currentSessionId) {
    try {
      const session = await db.tradingSession.findUnique({
        where: { id: agentState.currentSessionId },
      });
      if (session) {
        await db.tradingSession.update({
          where: { id: agentState.currentSessionId },
          data: {
            totalTrades: session.totalTrades + ordersPlaced,
            updatedAt: new Date(),
          },
        });
      }
    } catch (e) {
      // 세션 업데이트 실패는 무시
    }
  }

  // stocksAnalyzed가 0이면 원인 진단
  let zeroAnalysisReason: string | undefined;
  if (stocksAnalyzed === 0) {
    zeroAnalysisReason = diagnoseZeroAnalysis(
      kisConfig, kisClient,
      domesticStocks.length, overseasStocks.length,
      domesticSuccess, domesticFailed,
      candleErrors
    );
    addLog('INFO', 'DOMESTIC', `분석된 종목 없음 - 원인: ${zeroAnalysisReason}`);
  }

  // 결과 정리
  const endTime = new Date();
  const result: AgentCycleResult = {
    success: errors.length === 0,
    startTime,
    endTime,
    stocksAnalyzed,
    signalsGenerated,
    ordersPlaced,
    positionsMonitored,
    exitsExecuted,
    logs: [...agentState.logs].slice(0, 50), // 최근 50개
    errors,
    domesticSuccess,
    domesticFailed,
    overseasSuccess,
    overseasFailed,
    zeroAnalysisReason,
    // ── 진단 필드 ──
    uiSignalsCount,
    executableSignalsCount,
    signalsBlockedReasons: signalsBlockedReasons.slice(0, 10),
    topBuyCandidates: topBuyCandidates.slice(0, 5),
    signalThreshold: effectiveSettings.signalThreshold,
    weakSignalThreshold: effectiveSettings.weakSignalThreshold,
    minConfidenceThreshold: effectiveSettings.minConfidenceThreshold,
    strategyAggressiveness: effectiveSettings.strategyAggressiveness,
    positionQueryFailed,
    positionQueryFailedReason,
    forceTestSignalUsed,
  };

  agentState.lastCycleTime = endTime;
  agentState.lastCycleResult = result;
  agentState.totalCycles++;
  agentState.totalTrades += ordersPlaced;

  addLog('INFO', 'DOMESTIC', 
    `에이전트 사이클 완료: 분석 ${stocksAnalyzed}종목 (국내 성공 ${domesticSuccess}/실패 ${domesticFailed}), 신호 ${signalsGenerated}개, 주문 접수 ${ordersPlaced}건, 청산 ${exitsExecuted}건`
  );

  return result;
}

/**
 * 에이전트 시작
 */
export async function startAgent(): Promise<{ success: boolean; sessionId: string; message: string }> {
  if (agentState.isRunning) {
    return { success: false, sessionId: '', message: '이미 실행 중입니다.' };
  }

  try {
    // 기존 실행 중 세션 정지
    await db.tradingSession.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'STOPPED', stoppedAt: new Date() },
    });

    // 새 세션 생성
    const session = await db.tradingSession.create({
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    agentState.isRunning = true;
    agentState.currentSessionId = session.id;

    addLog('INFO', 'DOMESTIC', `자동매매 에이전트 시작 (세션: ${session.id})`);

    return { success: true, sessionId: session.id, message: '자동매매 에이전트가 시작되었습니다.' };
  } catch (error) {
    return { 
      success: false, 
      sessionId: '', 
      message: `시작 실패: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}

/**
 * 에이전트 중지
 */
export async function stopAgent(): Promise<{ success: boolean; message: string }> {
  if (!agentState.isRunning) {
    return { success: false, message: '실행 중이 아닙니다.' };
  }

  try {
    if (agentState.currentSessionId) {
      await db.tradingSession.update({
        where: { id: agentState.currentSessionId },
        data: { status: 'STOPPED', stoppedAt: new Date() },
      });
    }

    agentState.isRunning = false;
    agentState.currentSessionId = null;

    addLog('INFO', 'DOMESTIC', '자동매매 에이전트 중지');

    return { success: true, message: '자동매매 에이전트가 중지되었습니다.' };
  } catch (error) {
    return { 
      success: false, 
      message: `중지 실패: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}

/**
 * 에이전트 상태 조회
 */
export function getAgentStatus(): AgentStatus {
  return { ...agentState };
}

/**
 * 에이전트 로그 조회
 */
export function getAgentLogs(limit: number = 50): AgentLog[] {
  return agentState.logs.slice(0, limit);
}
