// 주문 실행 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { stockCode, orderType, quantity, price, orderKind, strategy, signalReason } = body;

    if (!stockCode || !orderType || !quantity) {
      return NextResponse.json(
        { success: false, error: '필수 항목 누락 (stockCode, orderType, quantity)' },
        { status: 400 }
      );
    }

    // 거래 내역 기록
    const stockNames: Record<string, string> = {
      '005930': '삼성전자',
      '000660': 'SK하이닉스',
      '373220': 'LG에너지솔루션',
      '006400': '삼성SDI',
      '051910': 'LG화학',
      '005380': '현대차',
      '035420': 'NAVER',
      '055550': '신한지주',
      '003670': '포스코홀딩스',
      '068270': '셀트리온',
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
        signalReason: signalReason || '수동 주문',
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

        orderResult = await client.placeOrder({
          stockCode,
          orderType,
          quantity,
          price,
          orderKind: orderKind || '01', // 기본 시장가
        });

        // 주문 결과 업데이트
        await db.tradeHistory.update({
          where: { id: tradeRecord.id },
          data: {
            status: orderResult.status === 'PENDING' ? 'FILLED' : orderResult.status,
            orderNo: orderResult.orderNo,
          },
        });
      } catch (apiError: any) {
        // KIS API 호출 실패 시 주문 실패로 처리 (모의 체결 금지)
        await db.tradeHistory.update({
          where: { id: tradeRecord.id },
          data: { status: 'FAILED' },
        });
        return NextResponse.json(
          { success: false, error: `주문 실패: ${apiError.message || 'KIS API 오류'}` },
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
      { success: false, error: '주문 실행 실패' },
      { status: 500 }
    );
  }
}
