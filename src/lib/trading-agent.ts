// 자동매매 에이전트 코어
// 시그널 생성 → 리스크 체크 → 주문 실행 → 포지션 모니터링 전체 파이프라인
// 국내주식 + 해외주식 지원

import { db } from './db';
import { KisApiClient } from './kis-api';
import { TradingEngine } from './trading-engine';
import { RiskManager } from './risk-manager';
import { getMarketRiskConfig } from './market-defaults';
import { 
  KisConfig, StockCandle, OverseasStockCandle, 
  BalanceItem, OverseasBalanceItem, MarketType,
  OrderRequest, TradingSignal
} from './types';

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
 */
async function loadKisConfig(): Promise<KisConfig | null> {
  const config = await db.kisConfig.findFirst();
  if (!config) return null;
  return {
    appKey: config.appKey,
    appSecret: config.appSecret,
    accountNo: config.accountNo,
    isDemo: config.isDemo,
    accessToken: config.accessToken || undefined,
    tokenExpiresAt: config.tokenExpiresAt ?? undefined,
  };
}

/**
 * 관심종목 + 보유종목 로드
 */
async function loadTargetStocks(): Promise<{
  domestic: Array<{ code: string; name: string }>;
  overseas: Array<{ code: string; name: string; exchange: string }>;
}> {
  // 관심종목
  const watchlist = await db.watchlistItem.findMany({
    where: { isActive: true },
  });

  const domestic = watchlist
    .filter(w => w.market === 'DOMESTIC')
    .map(w => ({ code: w.stockCode, name: w.stockName }));

  const overseas = watchlist
    .filter(w => w.market === 'OVERSEAS')
    .map(w => ({ 
      code: w.stockCode, 
      name: w.stockName, 
      exchange: w.exchangeCode || 'NAS' 
    }));

  // 관심종목이 없으면 기본 국내 종목 사용
  if (domestic.length === 0) {
    domestic.push(
      { code: '005930', name: '삼성전자' },
      { code: '000660', name: 'SK하이닉스' },
      { code: '373220', name: 'LG에너지솔루션' },
      { code: '005380', name: '현대차' },
      { code: '035420', name: 'NAVER' },
    );
  }

  // 해외주식은 관심종목에 있는 것만 분석 (기본값 없음)
  // 사용자가 명시적으로 추가한 해외종목만 매매 대상

  return { domestic, overseas };
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
 * 주문 실행 및 기록
 * - 리스크 매니저가 계산한 quantity를 실제 주문에 반영
 * - KIS API 주문 실패를 모의 체결로 바꾸지 않음
 * - 실제 체결이 확인된 경우에만 포지션 DB를 업데이트
 */
async function executeOrder(
  kisClient: KisApiClient | null,
  signal: TradingSignal,
  market: MarketType,
  exchangeCode?: string,
  quantity: number = 1
): Promise<{ success: boolean; orderNo: string; message: string }> {
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
    addLog('ERROR', market, 'KIS 미연결: 주문 불가', {
      stockCode: signal.stockCode,
      signalType: signal.signalType,
    });
    return { success: false, orderNo: '', message: 'KIS API 미연결: 주문을 실행할 수 없습니다. API 설정을 완료하고 토큰을 발급받으세요.' };
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

  // 주문 실패/대기 상태에서는 포지션을 변경하지 않음
  if (status !== 'FILLED') {
    return { success: false, orderNo, message };
  }

  // 포지션 DB 업데이트
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

  return { success: true, orderNo, message };
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

  // 2. 분석 대상 종목 로드
  const { domestic: domesticStocks, overseas: overseasStocks } = await loadTargetStocks();
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

        // 리스크 체크
        const riskCheck = domesticRisk.canTrade(
          signal, domesticPositions.positions, domesticPositions.accountBalance
        );

        if (riskCheck.allowed) {
          // 포지션 사이즈 계산
          const quantity = domesticRisk.calculatePositionSize(
            domesticPositions.accountBalance, signal.price, signal.confidence
          );

          // 주문 실행
          const result = await executeOrder(kisClient, { ...signal, price: signal.price }, 'DOMESTIC', undefined, quantity);

          if (result.success) {
            ordersPlaced++;
            addLog('TRADE', 'DOMESTIC',
              `${stock.name} ${signal.signalType} 주문 완료: ${quantity}주 @ ${signal.price}원 (${result.orderNo})`,
              { orderNo: result.orderNo, quantity, price: signal.price }
            );
          } else {
            addLog('ERROR', 'DOMESTIC',
              `${stock.name} ${signal.signalType} 주문 미체결/실패: ${result.message}`,
              { orderNo: result.orderNo, quantity, price: signal.price }
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

        // 리스크 체크
        const riskCheck = overseasRisk.canTrade(
          signal, overseasPositions.positions, overseasPositions.accountBalance
        );

        if (riskCheck.allowed) {
          const quantity = overseasRisk.calculatePositionSize(
            overseasPositions.accountBalance, signal.price, signal.confidence
          );

          const result = await executeOrder(kisClient, { ...signal, price: signal.price }, 'OVERSEAS', stock.exchange, quantity);

          if (result.success) {
            ordersPlaced++;
            addLog('TRADE', 'OVERSEAS',
              `${stock.name} ${signal.signalType} 주문 완료: ${quantity}주 @ $${signal.price} (${result.orderNo})`,
              { orderNo: result.orderNo, quantity, price: signal.price, exchange: stock.exchange }
            );
          } else {
            addLog('ERROR', 'OVERSEAS',
              `${stock.name} ${signal.signalType} 주문 미체결/실패: ${result.message}`,
              { orderNo: result.orderNo, quantity, price: signal.price, exchange: stock.exchange }
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
