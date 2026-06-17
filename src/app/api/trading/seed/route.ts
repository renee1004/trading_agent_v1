// 샘플 거래내역 시드 API
// InMemory DB가 비어있을 때 데모 데이터를 생성
// GET  /api/trading/seed         — 상태 확인
// GET  /api/trading/seed?reset=1 — 기존 데이터 삭제 후 재시드
// POST /api/trading/seed         — 시드 실행
// POST /api/trading/seed?reset=1 — 기존 데이터 삭제 후 재시드

import { NextRequest, NextResponse } from 'next/server';
import { db, getDbType } from '@/lib/db';

// 샘플 거래내역 데이터 생성 함수
async function seedTrades(forceReset: boolean) {
  try {
    // 기존 거래내역 확인
    const existing = await db.tradeHistory.findMany({ take: 1 });

    if (existing.length > 0 && !forceReset) {
      const totalCount = await db.tradeHistory.count();
      return NextResponse.json({
        success: false,
        message: '이미 거래내역이 존재합니다. 재시드하려면 ?reset=1 을 추가하세요.',
        existingCount: totalCount,
        dbType: getDbType(),
        hint: 'GET /api/trading/seed?reset=1 또는 POST /api/trading/seed?reset=1',
      });
    }

    // 강제 리셋: 기존 데이터 삭제
    if (forceReset && existing.length > 0) {
      await db.tradeHistory.deleteMany({});
      console.log('[Seed] 기존 거래내역 삭제 완료');
    }

    const now = new Date();
    const trades = [
      // ── 1. 삼성전자 / SUPER_TREND — 익절 (TAKE_PROFIT) ──
      {
        stockCode: '005930', stockName: '삼성전자', tradeType: 'BUY',
        quantity: 10, price: 72300, totalAmount: 723000,
        strategy: 'SUPER_TREND', signalReason: 'SuperTrend 상승 전환, RSI 55 지지 (신뢰도 78)',
        status: 'FILLED', orderNo: '00001', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 72100, orderPrice: 72300, filledPrice: 72300, avgFillPrice: 72300,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000 * 24), // 24시간 전 매수
      },
      {
        stockCode: '005930', stockName: '삼성전자', tradeType: 'SELL',
        quantity: 10, price: 75800, totalAmount: 758000,
        strategy: 'SUPER_TREND', signalReason: '목표가 도달 익절, 수익 실현 (신뢰도 82)',
        status: 'FILLED', orderNo: '00002', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 75800, orderPrice: 75800, filledPrice: 75800, avgFillPrice: 75800,
        slippagePercent: 0,
        profitLoss: 35000, profitRate: 4.84,
        tradedAt: new Date(now.getTime() - 3600000 * 20), // 20시간 전 매도 (보유 4시간)
      },

      // ── 2. SK하이닉스 / MOMENTUM — 손절 (STOP_LOSS) ──
      {
        stockCode: '000660', stockName: 'SK하이닉스', tradeType: 'BUY',
        quantity: 5, price: 178500, totalAmount: 892500,
        strategy: 'MOMENTUM', signalReason: '모멘텀 돌파, 거래량 증가 확인 (신뢰도 65)',
        status: 'FILLED', orderNo: '00003', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 178000, orderPrice: 178500, filledPrice: 178500, avgFillPrice: 178500,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000 * 30),
      },
      {
        stockCode: '000660', stockName: 'SK하이닉스', tradeType: 'SELL',
        quantity: 5, price: 169500, totalAmount: 847500,
        strategy: 'MOMENTUM', signalReason: '손절가 도달, 추세 이탈 (신뢰도 30)',
        status: 'FILLED', orderNo: '00004', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 169500, orderPrice: 169500, filledPrice: 169500, avgFillPrice: 169500,
        slippagePercent: 0,
        profitLoss: -45000, profitRate: -5.04,
        tradedAt: new Date(now.getTime() - 3600000 * 12), // 보유 18시간
      },

      // ── 3. 카카오 / MEAN_REVERSION — 익절 (TAKE_PROFIT) ──
      {
        stockCode: '035720', stockName: '카카오', tradeType: 'BUY',
        quantity: 20, price: 40500, totalAmount: 810000,
        strategy: 'MEAN_REVERSION', signalReason: '평균 회귀 과매도 반등, RSI 25 (신뢰도 72)',
        status: 'FILLED', orderNo: '00005', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 40600, orderPrice: 40500, filledPrice: 40500, avgFillPrice: 40500,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000 * 15),
      },
      {
        stockCode: '035720', stockName: '카카오', tradeType: 'SELL',
        quantity: 20, price: 42500, totalAmount: 850000,
        strategy: 'MEAN_REVERSION', signalReason: '평균 회귀 과매수 구간 도달, 익절 (신뢰도 80)',
        status: 'FILLED', orderNo: '00006', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 42700, orderPrice: 42500, filledPrice: 42500, avgFillPrice: 42500,
        slippagePercent: -0.47,
        profitLoss: 40000, profitRate: 4.94,
        tradedAt: new Date(now.getTime() - 3600000 * 10), // 보유 5시간
      },

      // ── 4. 현대차 / COMPOSITE — 트레일링스탑 (TRAILING_STOP) ──
      {
        stockCode: '005380', stockName: '현대자동차', tradeType: 'BUY',
        quantity: 8, price: 258000, totalAmount: 2064000,
        strategy: 'COMPOSITE', signalReason: '복합 지표 4중검증 통과, MACD 골든크로스 (신뢰도 85)',
        status: 'FILLED', orderNo: '00007', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 260000, orderPrice: 258000, filledPrice: 258000, avgFillPrice: 258000,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000 * 48),
      },
      {
        stockCode: '005380', stockName: '현대자동차', tradeType: 'SELL',
        quantity: 8, price: 271000, totalAmount: 2168000,
        strategy: 'COMPOSITE', signalReason: '트레일링 스탑 triggered, 추세 약화 (신뢰도 60)',
        status: 'FILLED', orderNo: '00008', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 271000, orderPrice: 271000, filledPrice: 271000, avgFillPrice: 271000,
        slippagePercent: 0,
        profitLoss: 104000, profitRate: 5.04,
        tradedAt: new Date(now.getTime() - 3600000 * 36), // 보유 12시간
      },

      // ── 5. 셀트리온 / VOLATILITY_BREAKOUT — 손절 (STOP_LOSS) ──
      {
        stockCode: '068270', stockName: '셀트리온', tradeType: 'BUY',
        quantity: 15, price: 182000, totalAmount: 2730000,
        strategy: 'VOLATILITY_BREAKOUT', signalReason: '변동성 돌파, 전일 범위 120% 확장 (신뢰도 70)',
        status: 'FILLED', orderNo: '00009', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 180500, orderPrice: 182000, filledPrice: 182000, avgFillPrice: 182000,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000 * 72),
      },
      {
        stockCode: '068270', stockName: '셀트리온', tradeType: 'SELL',
        quantity: 15, price: 173500, totalAmount: 2602500,
        strategy: 'VOLATILITY_BREAKOUT', signalReason: '손절가 도달, 돌파 실패 (신뢰도 25)',
        status: 'FILLED', orderNo: '00010', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 173500, orderPrice: 173500, filledPrice: 173500, avgFillPrice: 173500,
        slippagePercent: 0,
        profitLoss: -127500, profitRate: -4.67,
        tradedAt: new Date(now.getTime() - 3600000 * 60), // 보유 12시간
      },

      // ── 6. NVDA / MOMENTUM — 익절 (TAKE_PROFIT) ──
      {
        stockCode: 'NVDA', stockName: 'NVIDIA', tradeType: 'BUY',
        quantity: 2, price: 130.00, totalAmount: 260.00,
        strategy: 'MOMENTUM', signalReason: '모멘텀 강세, AI 수요 지속 (신뢰도 88)',
        status: 'FILLED', orderNo: '00011', market: 'OVERSEAS', exchangeCode: 'NAS',
        currency: 'USD', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 130.50, orderPrice: 130.00, filledPrice: 130.00, avgFillPrice: 130.00,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000 * 50),
      },
      {
        stockCode: 'NVDA', stockName: 'NVIDIA', tradeType: 'SELL',
        quantity: 2, price: 135.50, totalAmount: 271.00,
        strategy: 'MOMENTUM', signalReason: '목표가 도달 익절, 수익 실현 (신뢰도 90)',
        status: 'FILLED', orderNo: '00012', market: 'OVERSEAS', exchangeCode: 'NAS',
        currency: 'USD', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 134.80, orderPrice: 135.50, filledPrice: 135.50, avgFillPrice: 135.50,
        slippagePercent: -0.52,
        profitLoss: 11.00, profitRate: 4.23,
        tradedAt: new Date(now.getTime() - 3600000 * 40), // 보유 10시간
      },

      // ── 7. AAPL / MEAN_REVERSION — 트레일링스탑 (TRAILING_STOP) ──
      {
        stockCode: 'AAPL', stockName: 'Apple', tradeType: 'BUY',
        quantity: 5, price: 190.00, totalAmount: 950.00,
        strategy: 'MEAN_REVERSION', signalReason: '평균 회귀 과매도, RSI 28 (신뢰도 75)',
        status: 'FILLED', orderNo: '00013', market: 'OVERSEAS', exchangeCode: 'NAS',
        currency: 'USD', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 190.50, orderPrice: 190.00, filledPrice: 190.00, avgFillPrice: 190.00,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000 * 80),
      },
      {
        stockCode: 'AAPL', stockName: 'Apple', tradeType: 'SELL',
        quantity: 5, price: 198.25, totalAmount: 991.25,
        strategy: 'MEAN_REVERSION', signalReason: '트레일링 스탑 triggered, 모멘텀 약화 (신뢰도 55)',
        status: 'FILLED', orderNo: '00014', market: 'OVERSEAS', exchangeCode: 'NAS',
        currency: 'USD', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 199.00, orderPrice: 198.25, filledPrice: 198.25, avgFillPrice: 198.25,
        slippagePercent: -0.38,
        profitLoss: 41.25, profitRate: 4.34,
        tradedAt: new Date(now.getTime() - 3600000 * 70), // 보유 10시간
      },

      // ── 8. 삼성전자 / COMPOSITE — 미청산 (포지션 홀딩 중) ──
      {
        stockCode: '005930', stockName: '삼성전자', tradeType: 'BUY',
        quantity: 5, price: 74500, totalAmount: 372500,
        strategy: 'COMPOSITE', signalReason: '복합 지표 골든크로스, MACD 양전환 (신뢰도 80)',
        status: 'FILLED', orderNo: '00015', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 74800, orderPrice: 74500, filledPrice: 74500, avgFillPrice: 74500,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000 * 2), // 2시간 전 매수 (현재 홀딩)
      },

      // ── 9. 대기/차단/실패 주문 ──
      {
        stockCode: '051910', stockName: 'LG화학', tradeType: 'BUY',
        quantity: 2, price: 350000, totalAmount: 700000,
        strategy: 'COMPOSITE', signalReason: '복합 지표 4중검증 통과, MACD 골든크로스 (신뢰도 76)',
        status: 'PENDING', orderNo: '00016', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 351000, orderPrice: 350000,
        tradedAt: new Date(now.getTime() - 1800000), // 30분 전
      },
      {
        stockCode: '006400', stockName: '삼성SDI', tradeType: 'BUY',
        quantity: 3, price: 285000, totalAmount: 855000,
        strategy: 'VOLATILITY_BREAKOUT', signalReason: '변동성 돌파, 전일 고가 돌파 (신뢰도 68)',
        status: 'BLOCKED', orderNo: '', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 285000, orderPrice: 285000,
        msg1: '주문 차단: 장외 시간 주문 제한',
        tradedAt: new Date(now.getTime() - 14400000), // 4시간 전
      },
      {
        stockCode: '373220', stockName: 'LG에너지솔루션', tradeType: 'BUY',
        quantity: 1, price: 395000, totalAmount: 395000,
        strategy: 'SUPER_TREND', signalReason: 'SuperTrend 매수 신호 (신뢰도 62)',
        status: 'FAILED', orderNo: '', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 395000, orderPrice: 395000,
        rtCd: '1', msgCd: 'EGW00101', msg1: 'KIS 미연결: 접근토큰 없음',
        tradedAt: new Date(now.getTime() - 18000000), // 5시간 전
      },
    ];

    let created = 0;
    for (const trade of trades) {
      try {
        await db.tradeHistory.create({ data: trade });
        created++;
      } catch (err) {
        console.error('[Seed] Failed to create trade:', trade.stockName, err);
      }
    }

    return NextResponse.json({
      success: true,
      message: forceReset
        ? `기존 데이터 삭제 후 ${created}개의 샘플 거래내역이 재생성되었습니다.`
        : `${created}개의 샘플 거래내역이 생성되었습니다.`,
      created,
      reset: forceReset,
      dbType: getDbType(),
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Seed] Error:', errMsg);
    return NextResponse.json(
      { success: false, error: errMsg },
      { status: 500 }
    );
  }
}

// GET: 브라우저에서 직접 열 수 있도록 지원
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const reset = searchParams.get('reset') === '1';
  return seedTrades(reset);
}

// POST: API 호출용
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const reset = searchParams.get('reset') === '1';
  return seedTrades(reset);
}
