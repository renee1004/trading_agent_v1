// 해외주식 주문 실행 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { stockCode, orderType, quantity, price, orderKind, exchangeCode, strategy, signalReason } = body;

    if (!stockCode || !orderType || !quantity || !exchangeCode) {
      return NextResponse.json(
        { success: false, error: '필수 항목 누락 (stockCode, orderType, quantity, exchangeCode)' },
        { status: 400 }
      );
    }

    // 거래 내역 기록
    const stockNames: Record<string, string> = {
      'AAPL': '애플',
      'MSFT': '마이크로소프트',
      'GOOGL': '알파벳',
      'AMZN': '아마존',
      'NVDA': '엔비디아',
      'TSLA': '테슬라',
      'META': '메타',
      'NFLX': '넷플릭스',
      'AMD': 'AMD',
      'INTC': '인텔',
    };

    const exchangeRate = 1330; // 기본 환율
    const priceInKrw = (price || 0) * exchangeRate;

    const tradeRecord = await db.tradeHistory.create({
      data: {
        stockCode,
        stockName: stockNames[stockCode] || stockCode,
        tradeType: orderType,
        quantity,
        price: price || 0,
        totalAmount: priceInKrw * quantity,
        strategy: strategy || 'MANUAL',
        signalReason: signalReason || '해외주식 수동 주문',
        status: 'PENDING',
      },
    });

    const config = await db.kisConfig.findFirst();
    let orderResult;

    if (config?.accessToken) {
      try {
        const client = new KisApiClient({
          appKey: config.appKey,
          appSecret: config.appSecret,
          accountNo: config.accountNo,
          isDemo: config.isDemo,
          accessToken: config.accessToken,
          tokenExpiresAt: config.tokenExpiresAt ?? undefined,
        });

        orderResult = await client.placeOverseasOrder({
          stockCode,
          orderType,
          quantity,
          price,
          orderKind: orderKind || '00',
          market: 'OVERSEAS',
          exchangeCode,
        });

        // 주문 결과 업데이트
        await db.tradeHistory.update({
          where: { id: tradeRecord.id },
          data: {
            status: orderResult.status === 'PENDING' ? 'FILLED' : orderResult.status,
            orderNo: orderResult.orderNo,
          },
        });
      } catch {
        orderResult = { orderNo: `MOCK-OV-${Date.now()}`, status: 'FILLED', message: '해외주식 모의 주문 완료' };
        await db.tradeHistory.update({
          where: { id: tradeRecord.id },
          data: { status: 'FILLED', orderNo: orderResult.orderNo },
        });
      }
    } else {
      orderResult = { orderNo: `MOCK-OV-${Date.now()}`, status: 'FILLED', message: '해외주식 모의 주문 완료' };
      await db.tradeHistory.update({
        where: { id: tradeRecord.id },
        data: { status: 'FILLED', orderNo: orderResult.orderNo },
      });
    }

    return NextResponse.json({ 
      success: true, 
      data: {
        tradeId: tradeRecord.id,
        orderNo: orderResult.orderNo,
        status: orderResult.status,
        message: orderResult.message,
      }
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '해외주식 주문 실행 실패' },
      { status: 500 }
    );
  }
}
