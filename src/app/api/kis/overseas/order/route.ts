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

    // 거래 내역 기록 (USD 가격 그대로 저장, KRW 변환 금액은 totalAmount에 저장하지 않음)
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
      'RKLB': '로켓랩',
    };

    const tradeRecord = await db.tradeHistory.create({
      data: {
        stockCode,
        stockName: stockNames[stockCode] || stockCode,
        tradeType: orderType,
        quantity,
        price: price || 0,
        totalAmount: (price || 0) * quantity,
        strategy: strategy || 'MANUAL',
        signalReason: signalReason || '해외주식 수동 주문',
        status: 'PENDING',
        market: 'OVERSEAS',
        exchangeCode,
        currency: 'USD',
        source: 'MANUAL',
        orderExecutionMode: 'PAPER',
        currentPrice: price || 0,
        orderPrice: price || 0,
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

        // 주문 결과 업데이트 (KIS API 응답 포함)
        await db.tradeHistory.update({
          where: { id: tradeRecord.id },
          data: {
            status: orderResult.status === 'PENDING' ? 'FILLED' : orderResult.status,
            orderNo: orderResult.orderNo,
            filledPrice: orderResult.status === 'FILLED' ? price : null,
            avgFillPrice: orderResult.status === 'FILLED' ? price : null,
            rtCd: orderResult.rt_cd,
            msgCd: orderResult.msg_cd,
            msg1: orderResult.message,
          },
        });
      } catch (apiError: any) {
        // KIS API 호출 실패 시 주문 실패로 처리 (모의 체결 금지)
        await db.tradeHistory.update({
          where: { id: tradeRecord.id },
          data: { status: 'FAILED' },
        });
        return NextResponse.json(
          { success: false, error: `해외주식 주문 실패: ${apiError.message || 'KIS API 오류'}` },
          { status: 502 }
        );
      }
    } else {
      // 토큰 없으면 주문 거부 (가짜 주문 생성 금지)
      await db.tradeHistory.update({
        where: { id: tradeRecord.id },
        data: { status: 'REJECTED' },
      });
      return NextResponse.json(
        { success: false, error: 'KIS API 미연결: 토큰을 먼저 발급받으세요.' },
        { status: 403 }
      );
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
