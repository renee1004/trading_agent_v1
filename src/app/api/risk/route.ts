// 리스크 관리 설정 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { DEFAULT_RISK_CONFIG } from '@/lib/risk-manager';

export async function GET() {
  try {
    let config = await db.riskConfig.findFirst({
      where: { isActive: true },
    });

    if (!config) {
      config = await db.riskConfig.create({
        data: DEFAULT_RISK_CONFIG,
      });
    }

    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '리스크 설정 조회 실패' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      maxPositionSize,
      maxDailyLoss,
      maxTotalLoss,
      maxOpenPositions,
      stopLossPercent,
      takeProfitPercent,
      trailingStopPercent,
    } = body;

    const existing = await db.riskConfig.findFirst({ where: { isActive: true } });

    const updateData: Record<string, unknown> = {};
    if (typeof maxPositionSize === 'number') updateData.maxPositionSize = maxPositionSize;
    if (typeof maxDailyLoss === 'number') updateData.maxDailyLoss = maxDailyLoss;
    if (typeof maxTotalLoss === 'number') updateData.maxTotalLoss = maxTotalLoss;
    if (typeof maxOpenPositions === 'number') updateData.maxOpenPositions = maxOpenPositions;
    if (typeof stopLossPercent === 'number') updateData.stopLossPercent = stopLossPercent;
    if (typeof takeProfitPercent === 'number') updateData.takeProfitPercent = takeProfitPercent;
    if (typeof trailingStopPercent === 'number') updateData.trailingStopPercent = trailingStopPercent;

    let config;
    if (existing) {
      config = await db.riskConfig.update({
        where: { id: existing.id },
        data: updateData,
      });
    } else {
      config = await db.riskConfig.create({
        data: { ...DEFAULT_RISK_CONFIG, ...updateData },
      });
    }

    return NextResponse.json({ success: true, data: config });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '리스크 설정 업데이트 실패' },
      { status: 500 }
    );
  }
}
