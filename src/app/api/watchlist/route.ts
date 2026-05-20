// 관심종목 관리 라우트

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

export async function GET() {
  try {
    const items = await db.watchlistItem.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });

    // 기본 관심종목이 없으면 시드
    if (items.length === 0) {
      const defaults = [
        { stockCode: '005930', stockName: '삼성전자', sector: '반도체' },
        { stockCode: '000660', stockName: 'SK하이닉스', sector: '반도체' },
        { stockCode: '373220', stockName: 'LG에너지솔루션', sector: '2차전지' },
        { stockCode: '005380', stockName: '현대차', sector: '자동차' },
        { stockCode: '035420', stockName: 'NAVER', sector: '인터넷' },
        { stockCode: '055550', stockName: '신한지주', sector: '금융' },
        { stockCode: '068270', stockName: '셀트리온', sector: '바이오' },
        { stockCode: '006400', stockName: '삼성SDI', sector: '2차전지' },
        { stockCode: '051910', stockName: 'LG화학', sector: '화학' },
        { stockCode: '003670', stockName: '포스코홀딩스', sector: '철강' },
      ];

      for (const item of defaults) {
        await db.watchlistItem.create({ data: item });
      }

      return NextResponse.json({ 
        success: true, 
        data: await db.watchlistItem.findMany({
          where: { isActive: true },
          orderBy: { createdAt: 'desc' },
        })
      });
    }

    return NextResponse.json({ success: true, data: items });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '관심종목 조회 실패' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { stockCode, stockName, sector } = body;

    if (!stockCode || !stockName) {
      return NextResponse.json(
        { success: false, error: '종목코드와 종목명 필요' },
        { status: 400 }
      );
    }

    const item = await db.watchlistItem.create({
      data: { stockCode, stockName, sector },
    });

    return NextResponse.json({ success: true, data: item });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '관심종목 추가 실패' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'ID 필요' },
        { status: 400 }
      );
    }

    await db.watchlistItem.update({
      where: { id },
      data: { isActive: false },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '관심종목 삭제 실패' },
      { status: 500 }
    );
  }
}
