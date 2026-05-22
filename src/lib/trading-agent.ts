// 자동매매 에이전트 코어
// 시그널 생성 → 리스크 체크 → 주문 실행 → 포지션 모니터링 전체 파이프라인
// 국내주식 + 해외주식 지원

import { db } from './db';
import { KisApiClient } from './kis-api';
import { TradingEngine } from './trading-engine';
import { RiskManager } from './risk-manager';
import { getMarketRiskConfig } from './market-defaults';
import { scanTargetStocks } from './market-scanner';
import { aiAnalyzer } from './ai-analyzer';
import { 
  KisConfig, StockCandle, OverseasStockCandle, 
  BalanceItem, OverseasBalanceItem, MarketType,
  OrderRequest, TradingSignal
} from './types';
import { getDomesticSession, getKSTNow, DomesticSession } from './agent-scheduler';
import { getOrCreateKisConfigFromEnv } from './kis-config-loader';

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
    addLog('INFO', 'DOMESTIC', `KIS 설정 로드 완료 (appKey=${maskedKey}, accountNo=${config.accountNo}, isDemo=${config.isDemo})`);
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
 */
async function fetchCandles(
  kisClient: KisApiClient | null,
  stockCode: string,
  market: MarketType,
  exchangeCode?: string
): Promise<StockCandle[]> {
  // KIS 클라이언트가 없으면 조회 불가
  if (!kisClient) {
    addLog('ERROR', market, `${stockCode} 캔들 조회 불가 - KIS 클라이언트 없음`);
    return [];
  }

  try {
    if (market === 'OVERSEAS' && exchangeCode) {
      const overseasCandles = await kisClient.getOverseasDailyCandles(
        stockCode, exchangeCode, '3M'
      );
      // OverseasStockCandle → StockCandle 변환
      return overseasCandles.map(c => ({
        date: c.date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
    } else {
      return await kisClient.getStockDailyCandles(stockCode, '3M');
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    addLog('ERROR', market, `${stockCode} 캔들 데이터 조회 실패`, {
      error: errorMsg,
    });
    return [];
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
    addLog('ERROR', market, '포지션 조회 실패', {
      error: error instanceof Error ? error.message : String(error),
    });
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
 * - PREMARKET_CLOSE, OPENING_CALL_AUCTION, CLOSING_CALL_AUCTION,
 *   POSTMARKET_CLOSE, AFTERHOURS_SINGLE: 기본 차단
 * - 시간외 주문은 ALLOW_AFTER_HOURS_TRADING=true 환경변수 설정 시에만 허용
 */
function getDomesticOrderPolicy(signal: TradingSignal): { allowed: boolean; reason: string; session: DomesticSession } {
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

  // 시간외 세션: 기본 차단, ALLOW_AFTER_HOURS_TRADING=true인 경우만 허용
  const afterHoursSessions: DomesticSession[] = [
    'PREMARKET_CLOSE', 'OPENING_CALL_AUCTION', 'CLOSING_CALL_AUCTION',
    'POSTMARKET_CLOSE', 'AFTERHOURS_SINGLE',
  ];
  if (afterHoursSessions.includes(session)) {
    if (process.env.ALLOW_AFTER_HOURS_TRADING === 'true') {
      return { allowed: true, reason: `시간외 거래 허용 (${sessionInfo.label}, ALLOW_AFTER_HOURS_TRADING=true)`, session };
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
  exchangeCode?: string,
  quantity: number = 1
): Promise<{ success: boolean; orderNo: string; message: string }> {
  // 국내 주문: 거래세션 정책 체크 (KIS placeOrder 호출 전)
  if (market === 'DOMESTIC') {
    const policy = getDomesticOrderPolicy(signal);
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
  return { success: true, orderNo, message: `주문 접수 완료 (${status}) - ${message}` };
}

/**
 * 포지션 모니터링 - 손절/익절/트레일링스톱 체크
 */
async function monitorPositions(
  kisClient: KisApiClient | null,
  market: MarketType
): Promise<number> {
  let exitsExecuted = 0;

  const riskConfig = getMarketRiskConfig(market);
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
          position.exchangeCode,
          position.quantity
        );

        if (result.success) {
          exitsExecuted++;
          addLog('TRADE', market, 
            `${position.stockName} 청산 주문 완료: ${position.quantity}주 (${result.orderNo})`,
            { orderNo: result.orderNo, quantity: position.quantity, reason: exitCheck.reason }
          );
        }
      }
    } catch (error) {
      addLog('ERROR', market, `${position.stockName} 포지션 모니터링 오류`, {
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
 * 에이전트 1사이클 실행
 * 시그널 분석 → 리스크 체크 → 주문 실행 → 포지션 모니터링
 */
export async function runAgentCycle(): Promise<AgentCycleResult> {
  const startTime = new Date();
  const errors: string[] = [];
  let stocksAnalyzed = 0;
  let signalsGenerated = 0;
  let ordersPlaced = 0;
  let positionsMonitored = 0;
  let exitsExecuted = 0;

  addLog('INFO', 'DOMESTIC', '에이전트 사이클 시작');

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

  // 3. 리스크 매니저 초기화
  const domesticRisk = new RiskManager(getMarketRiskConfig('DOMESTIC'), 'DOMESTIC');
  const overseasRisk = new RiskManager(getMarketRiskConfig('OVERSEAS'), 'OVERSEAS');

  // 4. 현재 포지션 조회
  const domesticPositions = await fetchPositions(kisClient, 'DOMESTIC');
  const overseasPositions = await fetchPositions(kisClient, 'OVERSEAS');

  // ========================================
  // 국내주식 분석 & 매매
  // ========================================
  addLog('INFO', 'DOMESTIC', '국내주식 분석 시작');

  for (const stock of domesticStocks) {
    try {
      // 캔들 데이터 조회
      const candles = await fetchCandles(kisClient, stock.code, 'DOMESTIC');
      if (candles.length < 30) {
        addLog('INFO', 'DOMESTIC', `${stock.name} 데이터 부족 (${candles.length}개)`);
        continue;
      }

      stocksAnalyzed++;

      // 전략 분석
      const signal = TradingEngine.analyze(candles, stock.code, stock.name, 'ALL', 'DOMESTIC');

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
          // 포지션 사이즈 계산
          const quantity = domesticRisk.calculatePositionSize(
            domesticPositions.accountBalance, finalSignal.price, finalSignal.confidence
          );

          // 주문 실행
          const result = await executeOrder(kisClient, { ...finalSignal, price: finalSignal.price }, 'DOMESTIC', undefined, quantity);

          if (result.success) {
            ordersPlaced++;
            addLog('TRADE', 'DOMESTIC',
              `${stock.name} ${finalSignal.signalType} 주문 완료: ${quantity}주 @ ${finalSignal.price}원 (${result.orderNo})`,
              { orderNo: result.orderNo, quantity, price: finalSignal.price }
            );
          } else {
            addLog('ERROR', 'DOMESTIC',
              `${stock.name} ${finalSignal.signalType} 주문 미체결/실패: ${result.message}`,
              { orderNo: result.orderNo, quantity, price: finalSignal.price }
            );
          }
        } else {
          addLog('RISK', 'DOMESTIC',
            `${stock.name} 매매 차단: ${riskCheck.reason}`,
            { reason: riskCheck.reason }
          );
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`국내 ${stock.name}: ${errMsg}`);
      addLog('ERROR', 'DOMESTIC', `${stock.name} 분석 오류: ${errMsg}`);
    }
  }

  // ========================================
  // 해외주식 분석 & 매매
  // ========================================
  addLog('INFO', 'OVERSEAS', '해외주식 분석 시작');

  for (const stock of overseasStocks) {
    try {
      const candles = await fetchCandles(kisClient, stock.code, 'OVERSEAS', stock.exchange);
      if (candles.length < 30) {
        addLog('INFO', 'OVERSEAS', `${stock.name} 데이터 부족 (${candles.length}개)`);
        continue;
      }

      stocksAnalyzed++;

      // 전략 분석
      const signal = TradingEngine.analyze(candles, stock.code, stock.name, 'ALL', 'OVERSEAS');

      if (signal.signalType !== 'HOLD') {
        signalsGenerated++;
        addLog('SIGNAL', 'OVERSEAS',
          `${stock.name} ${signal.signalType} 신호 (신뢰도: ${signal.confidence}%) - ${signal.reason}`,
          { signalType: signal.signalType, confidence: signal.confidence, price: signal.price, strategy: signal.strategy }
        );

        // AI 분석으로 신호 검증 (비동기, 실패 시 기술적 신호만 사용)
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

        // AI 검증 후 HOLD로 변경된 경우 매매 차단
        if (finalSignal.signalType === 'HOLD') {
          addLog('RISK', 'OVERSEAS', `${stock.name} AI 검증 결과 HOLD로 변경 - 매매 차단`);
          continue;
        }

        // 리스크 체크
        const riskCheck = overseasRisk.canTrade(
          finalSignal, overseasPositions.positions, overseasPositions.accountBalance
        );

        if (riskCheck.allowed) {
          const quantity = overseasRisk.calculatePositionSize(
            overseasPositions.accountBalance, finalSignal.price, finalSignal.confidence
          );

          const result = await executeOrder(kisClient, { ...finalSignal, price: finalSignal.price }, 'OVERSEAS', stock.exchange, quantity);

          if (result.success) {
            ordersPlaced++;
            addLog('TRADE', 'OVERSEAS',
              `${stock.name} ${finalSignal.signalType} 주문 완료: ${quantity}주 @ $${finalSignal.price} (${result.orderNo})`,
              { orderNo: result.orderNo, quantity, price: finalSignal.price, exchange: stock.exchange }
            );
          } else {
            addLog('ERROR', 'OVERSEAS',
              `${stock.name} ${finalSignal.signalType} 주문 미체결/실패: ${result.message}`,
              { orderNo: result.orderNo, quantity, price: finalSignal.price, exchange: stock.exchange }
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
      addLog('ERROR', 'OVERSEAS', `${stock.name} 분석 오류: ${errMsg}`);
    }
  }

  // ========================================
  // 포지션 동기화 (Reconciliation)
  // KIS 잔고 API에서 실제 보유 종목을 가져와 로컬 DB 동기화
  // 주문 후 낙관적 업데이트된 포지션을 실제 잔고 기준으로 보정
  // ========================================
  if (kisClient) {
    addLog('INFO', 'DOMESTIC', '포지션 동기화 시작 (잔고 기준)');
    await reconcilePositions(kisClient, 'DOMESTIC');
    await reconcilePositions(kisClient, 'OVERSEAS');
  }

  // ========================================
  // 포지션 모니터링 (손절/익절/트레일링스톱)
  // ========================================
  addLog('INFO', 'DOMESTIC', '포지션 모니터링 시작');
  
  const domesticExits = await monitorPositions(kisClient, 'DOMESTIC');
  const overseasExits = await monitorPositions(kisClient, 'OVERSEAS');
  exitsExecuted = domesticExits + overseasExits;
  positionsMonitored = domesticPositions.positions.length + overseasPositions.positions.length;

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
  };

  agentState.lastCycleTime = endTime;
  agentState.lastCycleResult = result;
  agentState.totalCycles++;
  agentState.totalTrades += ordersPlaced;

  addLog('INFO', 'DOMESTIC', 
    `에이전트 사이클 완료: 분석 ${stocksAnalyzed}종목, 신호 ${signalsGenerated}개, 주문 ${ordersPlaced}건, 청산 ${exitsExecuted}건`
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
