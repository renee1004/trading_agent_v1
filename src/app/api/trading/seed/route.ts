// 샘플 거래내역 시드 API
// InMemory DB가 비어있을 때 데모 데이터를 생성
// POST /api/trading/seed

import { NextResponse } from 'next/server';
import { db, getDbType } from '@/lib/db';

export async function POST() {
  try {
    // 기존 거래내역 확인
    const existing = await db.tradeHistory.findMany({ take: 1 });
    if (existing.length > 0) {
      return NextResponse.json({
        success: false,
        message: '이미 거래내역이 존재합니다. 시드를 건너뜁니다.',
        existingCount: existing.length,
      });
    }

    const now = new Date();
    const trades = [
      // 오늘 성공된 국내 주식 거래
      {
        stockCode: '005930', stockName: '삼성전자', tradeType: 'BUY',
        quantity: 10, price: 72300, totalAmount: 723000,
        strategy: 'SUPER_TREND', signalReason: 'SuperTrend 상승 전환, RSI 55 지지',
        status: 'FILLED', orderNo: '00001', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 72100, orderPrice: 72300, filledPrice: 72300, avgFillPrice: 72300,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 3600000), // 1시간 전
      },
      {
        stockCode: '000660', stockName: 'SK하이닉스', tradeType: 'BUY',
        quantity: 5, price: 178500, totalAmount: 892500,
        strategy: 'MOMENTUM', signalReason: '모멘텀 돌파, 거래량 증가 확인',
        status: 'FILLED', orderNo: '00002', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 178000, orderPrice: 178500, filledPrice: 178500, avgFillPrice: 178500,
        slippagePercent: 0,
        tradedAt: new Date(now.getTime() - 7200000), // 2시간 전
      },
      {
        stockCode: '035720', stockName: '카카오', tradeType: 'SELL',
        quantity: 20, price: 42500, totalAmount: 850000,
        strategy: 'MEAN_REVERSION', signalReason: '평균 회귀 과매수 구간 도달, 익절',
        status: 'FILLED', orderNo: '00003', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 42700, orderPrice: 42500, filledPrice: 42500, avgFillPrice: 42500,
        slippagePercent: -0.47,
        profitLoss: 40000, profitRate: 4.94,
        tradedAt: new Date(now.getTime() - 10800000), // 3시간 전
      },
      // 대기 중인 주문
      {
        stockCode: '051910', stockName: 'LG화학', tradeType: 'BUY',
        quantity: 2, price: 350000, totalAmount: 700000,
        strategy: 'COMPOSITE', signalReason: '복합 지표 4중검증 통과, MACD 골든크로스',
        status: 'PENDING', orderNo: '00004', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 351000, orderPrice: 350000,
        tradedAt: new Date(now.getTime() - 1800000), // 30분 전
      },
      // 차단된 주문
      {
        stockCode: '006400', stockName: '삼성SDI', tradeType: 'BUY',
        quantity: 3, price: 285000, totalAmount: 855000,
        strategy: 'VOLATILITY_BREAKOUT', signalReason: '변동성 돌파, 전일 고가 돌파',
        status: 'BLOCKED', orderNo: '', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 285000, orderPrice: 285000,
        msg1: '주문 차단: 장외 시간 주문 제한',
        tradedAt: new Date(now.getTime() - 14400000), // 4시간 전
      },
      // 실패한 주문
      {
        stockCode: '373220', stockName: 'LG에너지솔루션', tradeType: 'BUY',
        quantity: 1, price: 395000, totalAmount: 395000,
        strategy: 'SUPER_TREND', signalReason: 'SuperTrend 매수 신호',
        status: 'FAILED', orderNo: '', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 395000, orderPrice: 395000,
        rtCd: '1', msgCd: 'EGW00101', msg1: 'KIS 미연결: 접근토큰 없음',
        tradedAt: new Date(now.getTime() - 18000000), // 5시간 전
      },
      // 해외 주식 거래
      {
        stockCode: 'NVDA', stockName: 'NVIDIA', tradeType: 'BUY',
        quantity: 2, price: 135.50, totalAmount: 271.00,
        strategy: 'MOMENTUM', signalReason: '모멘텀 강세, AI 수요 지속',
        status: 'FILLED', orderNo: '00006', market: 'OVERSEAS', exchangeCode: 'NAS',
        currency: 'USD', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 134.80, orderPrice: 135.50, filledPrice: 135.50, avgFillPrice: 135.50,
        slippagePercent: -0.52,
        tradedAt: new Date(now.getTime() - 5400000), // 1.5시간 전
      },
      {
        stockCode: 'AAPL', stockName: 'Apple', tradeType: 'SELL',
        quantity: 5, price: 198.25, totalAmount: 991.25,
        strategy: 'MEAN_REVERSION', signalReason: '평균 회귀 과매수, RSI 75',
        status: 'FILLED', orderNo: '00007', market: 'OVERSEAS', exchangeCode: 'NAS',
        currency: 'USD', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 199.00, orderPrice: 198.25, filledPrice: 198.25, avgFillPrice: 198.25,
        slippagePercent: -0.38,
        profitLoss: 45.75, profitRate: 4.83,
        tradedAt: new Date(now.getTime() - 9000000), // 2.5시간 전
      },
      // 어제 거래
      {
        stockCode: '005380', stockName: '현대자동차', tradeType: 'BUY',
        quantity: 8, price: 258000, totalAmount: 2064000,
        strategy: 'COMPOSITE', signalReason: '복합 지표 매수, 볼린저 밴드 하단 터치',
        status: 'FILLED', orderNo: '00008', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 260000, orderPrice: 258000, filledPrice: 258000, avgFillPrice: 258000,
        slippagePercent: 0,
        profitLoss: 16000, profitRate: 0.78,
        tradedAt: new Date(now.getTime() - 86400000), // 1일 전
      },
      {
        stockCode: '068270', stockName: '셀트리온', tradeType: 'BUY',
        quantity: 15, price: 182000, totalAmount: 2730000,
        strategy: 'VOLATILITY_BREAKOUT', signalReason: '변동성 돌파, 전일 범위 120% 확장',
        status: 'FILLED', orderNo: '00009', market: 'DOMESTIC', exchangeCode: null,
        currency: 'KRW', source: 'AGENT', orderExecutionMode: 'DRY_RUN',
        currentPrice: 180500, orderPrice: 182000, filledPrice: 182000, avgFillPrice: 182000,
        slippagePercent: 0,
        profitLoss: -22500, profitRate: -0.82,
        tradedAt: new Date(now.getTime() - 172800000), // 2일 전
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
      message: `${created}개의 샘플 거래내역이 생성되었습니다.`,
      created,
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
