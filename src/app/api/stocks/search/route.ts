// 통합 종목 검색 API
// 국내/해외 전체 KIS 종목 마스터 기반 검색
// ⚠️ KIS 현재가 API 호출 금지 - 로컬 마스터 JSON만 사용

import { NextRequest, NextResponse } from 'next/server';
import { searchAllStocks, type StockSearchResult } from '@/lib/stock-master';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') || '';
    const limit = parseInt(searchParams.get('limit') || '30');

    if (!query || query.length < 1) {
      return NextResponse.json({
        success: true,
        data: [],
        total: 0,
      });
    }

    const results = searchAllStocks(query, limit);

    return NextResponse.json({
      success: true,
      data: results,
      total: results.length,
    });
  } catch (error) {
    console.error('[Stocks Search] 검색 실패:', error);
    return NextResponse.json(
      { success: false, error: '종목 검색 실패' },
      { status: 500 },
    );
  }
}
