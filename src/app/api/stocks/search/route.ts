// 통합 종목 검색 API
// 국내/해외 전체 KIS 종목 마스터 기반 검색
// ⚠️ KIS 현재가 API 호출 금지 - 로컬 마스터 JSON만 사용

import { NextRequest, NextResponse } from 'next/server';
import { searchAllStocks, getDomesticMasterSize } from '@/lib/stock-master';
import { getOverseasMasterSize, getJsonMasterSize } from '@/lib/kis-overseas-master';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') || '';
    const limit = parseInt(searchParams.get('limit') || '30');
    const debug = searchParams.get('debug') === '1';

    // debug 모드: 마스터 데이터 상태 반환 (검색 진단용)
    if (debug) {
      return NextResponse.json({
        success: true,
        debug: {
          domesticMasterSize: getDomesticMasterSize(),
          overseasMasterSize: getOverseasMasterSize(),
          overseasJsonSize: getJsonMasterSize(),
          query,
          timestamp: new Date().toISOString(),
        },
      });
    }

    if (!query || query.length < 1) {
      return NextResponse.json({
        success: true,
        data: [],
        total: 0,
      });
    }

    const results = searchAllStocks(query, limit);
    console.log(`[Stocks Search] q="${query}" → ${results.length}건 (국내:${results.filter(r => r.market === 'DOMESTIC').length} 해외:${results.filter(r => r.market === 'OVERSEAS').length})`);

    return NextResponse.json({
      success: true,
      data: results,
      total: results.length,
    });
  } catch (error) {
    console.error('[Stocks Search] 검색 실패:', error);
    return NextResponse.json(
      { success: false, error: '종목 검색 실패', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
