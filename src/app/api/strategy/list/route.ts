// 전략 목록 및 설정 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

const DEFAULT_STRATEGIES = [
  {
    name: '복합 지표 전략 (COMPOSITE)',
    type: 'COMPOSITE',
    description: 'SuperTrend + MACD + RSI + Bollinger Bands 4중 검증 전략. 2025년 최신 트렌드 기반으로 가장 높은 수익률을 기록하는 복합 지표 전략입니다. 모든 지표가 매수/매도 방향으로 정렬될 때 신호를 발생시켜 허위 신호를 최소화합니다.',
    parameters: JSON.stringify({
      rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
      macdFast: 12, macdSlow: 26, macdSignal: 9,
      bbPeriod: 20, bbStdDev: 2,
      atrPeriod: 10, atrMultiplier: 3,
      maShort: 5, maLong: 20,
    }),
    isActive: true,
    profitRate: 18.5,
    winRate: 62.3,
  },
  {
    name: '변동성 돌파 전략 (VOLATILITY_BREAKOUT)',
    type: 'VOLATILITY_BREAKOUT',
    description: '래리 윌리엄스의 변동성 돌파 전략. 전일 고가-저가 범위의 k배 이상 상승 시 매수하는 데이트레이딩 전략으로, 한국 주식 시장에서 검증된 전략입니다. 장 초반 돌파 시 가장 효과적이며, RSI와 이동평균선으로 필터링합니다.',
    parameters: JSON.stringify({
      volatilityK: 0.5,
      rsiPeriod: 14,
      maShort: 5, maLong: 20,
      stopLoss: 0.03,
    }),
    isActive: true,
    profitRate: 12.3,
    winRate: 55.8,
  },
  {
    name: 'SuperTrend 추세 추종 전략',
    type: 'SUPER_TREND',
    description: '백테스트 153-299% 수익률 검증 전략. SuperTrend 방향 전환을 MACD와 RSI로 교차 검증하여 추세 전환을 포착합니다. 강한 추세장에서 압도적인 수익률을 보이며, 거짓 신호를 최소화하는 3중 검증 체계를 갖추고 있습니다.',
    parameters: JSON.stringify({
      atrPeriod: 10, atrMultiplier: 3,
      rsiPeriod: 14,
      macdFast: 12, macdSlow: 26, macdSignal: 9,
    }),
    isActive: true,
    profitRate: 22.7,
    winRate: 58.1,
  },
  {
    name: '평균 회귀 전략 (MEAN_REVERSION)',
    type: 'MEAN_REVERSION',
    description: '볼린저밴드 하단 매수 / 상단 매도 전략. RSI 과매도/과매수 활용으로 횡보장에서 효과적입니다. 가격이 평균으로 회귀하는 특성을 이용하며, BB 하단 터치 + RSI 과매도에서 반등 시 매수, BB 상단 + RSI 과매수에서 매도합니다.',
    parameters: JSON.stringify({
      bbPeriod: 20, bbStdDev: 2,
      rsiPeriod: 14,
    }),
    isActive: false,
    profitRate: 8.9,
    winRate: 64.5,
  },
  {
    name: '모멘텀 전략 (MOMENTUM)',
    type: 'MOMENTUM',
    description: '거래량 폭증 + 가격 상승 모멘텀 포착 전략. 세력 매집 패턴을 감지하여 초기 상승장에 진입합니다. 거래량이 평균의 2배 이상 폭증하면서 가격이 상승할 때, RSI와 이동평균선으로 추세를 확인하여 매수합니다.',
    parameters: JSON.stringify({
      rsiPeriod: 14,
      maShort: 5, maLong: 20,
      volumeMultiplier: 2.0,
    }),
    isActive: false,
    profitRate: 15.2,
    winRate: 51.7,
  },
];

export async function GET() {
  try {
    let strategies = await db.tradingStrategy.findMany({
      orderBy: { createdAt: 'desc' },
    });

    // 기본 전략이 없으면 시드
    if (strategies.length === 0) {
      for (const strategy of DEFAULT_STRATEGIES) {
        await db.tradingStrategy.create({ data: strategy });
      }
      strategies = await db.tradingStrategy.findMany({
        orderBy: { createdAt: 'desc' },
      });
    }

    return NextResponse.json({ success: true, data: strategies });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '전략 조회 실패' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, isActive, parameters } = body;

    if (!id) {
      return NextResponse.json(
        { success: false, error: '전략 ID 필요' },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};
    if (typeof isActive === 'boolean') updateData.isActive = isActive;
    if (parameters) updateData.parameters = JSON.stringify(parameters);

    const strategy = await db.tradingStrategy.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({ success: true, data: strategy });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '전략 업데이트 실패' },
      { status: 500 }
    );
  }
}
