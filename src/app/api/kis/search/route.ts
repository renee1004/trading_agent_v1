// 주식 종목 검색 API
// 종목명/종목코드로 검색하여 결과 반환

import { NextRequest, NextResponse } from 'next/server';

// 한국 주요 종목 데이터베이스 (KOSPI/KOSDAQ 대표 종목)
const STOCK_DATABASE = [
  // 반도체
  { code: '005930', name: '삼성전자', sector: '반도체', market: 'KOSPI' },
  { code: '000660', name: 'SK하이닉스', sector: '반도체', market: 'KOSPI' },
  { code: '042700', name: '한미반도체', sector: '반도체', market: 'KOSDAQ' },
  { code: '403870', name: 'HPSP', sector: '반도체', market: 'KOSDAQ' },
  { code: '240810', name: '원익IPS', sector: '반도체', market: 'KOSDAQ' },
  { code: '036930', name: '주성엔지니어링', sector: '반도체', market: 'KOSDAQ' },
  { code: '098460', name: '고영', sector: '반도체', market: 'KOSDAQ' },
  { code: '060280', name: 'LS전선아시아', sector: '반도체', market: 'KOSPI' },
  
  // 2차전지
  { code: '373220', name: 'LG에너지솔루션', sector: '2차전지', market: 'KOSPI' },
  { code: '006400', name: '삼성SDI', sector: '2차전지', market: 'KOSPI' },
  { code: '051910', name: 'LG화학', sector: '2차전지', market: 'KOSPI' },
  { code: '247540', name: '에코프로비엠', sector: '2차전지', market: 'KOSDAQ' },
  { code: '086520', name: '에코프로', sector: '2차전지', market: 'KOSDAQ' },
  { code: '012450', name: '한화에어로스페이스', sector: '2차전지', market: 'KOSPI' },
  { code: '003670', name: '포스코홀딩스', sector: '2차전지', market: 'KOSPI' },
  { code: '096770', name: 'SK이노베이션', sector: '2차전지', market: 'KOSPI' },
  
  // 자동차
  { code: '005380', name: '현대차', sector: '자동차', market: 'KOSPI' },
  { code: '000270', name: '기아', sector: '자동차', market: 'KOSPI' },
  { code: '018880', name: '한온시스템', sector: '자동차부품', market: 'KOSPI' },
  { code: '161390', name: '한국타이어앤테크놀로지', sector: '자동차부품', market: 'KOSPI' },
  { code: '204320', name: '대창단조', sector: '자동차부품', market: 'KOSDAQ' },
  
  // 인터넷/플랫폼
  { code: '035420', name: 'NAVER', sector: '인터넷', market: 'KOSPI' },
  { code: '035720', name: '카카오', sector: '인터넷', market: 'KOSPI' },
  { code: '263750', name: '펫프렌즈', sector: '인터넷', market: 'KOSDAQ' },
  { code: '323130', name: '템코', sector: '인터넷', market: 'KOSDAQ' },
  
  // 금융
  { code: '055550', name: '신한지주', sector: '금융', market: 'KOSPI' },
  { code: '105560', name: 'KB금융', sector: '금융', market: 'KOSPI' },
  { code: '005830', name: 'DB손해보험', sector: '금융', market: 'KOSPI' },
  { code: '086790', name: '하나금융지주', sector: '금융', market: 'KOSPI' },
  { code: '316140', name: '우리금융지주', sector: '금융', market: 'KOSPI' },
  { code: '024110', name: '기업은행', sector: '금융', market: 'KOSPI' },
  { code: '138930', name: 'BNK금융지주', sector: '금융', market: 'KOSPI' },
  { code: '004000', name: '메리츠금융지주', sector: '금융', market: 'KOSPI' },
  
  // 바이오/헬스케어
  { code: '068270', name: '셀트리온', sector: '바이오', market: 'KOSPI' },
  { code: '326030', name: 'SK바이오팜', sector: '바이오', market: 'KOSPI' },
  { code: '207940', name: '삼성바이오로직스', sector: '바이오', market: 'KOSPI' },
  { code: '145020', name: '휴젤', sector: '바이오', market: 'KOSPI' },
  { code: '141080', name: '렉손메디칼', sector: '바이오', market: 'KOSDAQ' },
  { code: '328130', name: '나노엔텍', sector: '바이오', market: 'KOSDAQ' },
  { code: '196170', name: '알테오젠', sector: '바이오', market: 'KOSDAQ' },
  
  // 통신
  { code: '017670', name: 'SK텔레콤', sector: '통신', market: 'KOSPI' },
  { code: '030200', name: 'KT', sector: '통신', market: 'KOSPI' },
  { code: '032640', name: 'LG유플러스', sector: '통신', market: 'KOSPI' },
  
  // 엔터테인먼트/미디어
  { code: '352820', name: '하이브', sector: '엔터', market: 'KOSPI' },
  { code: '041510', name: '에스엠', sector: '엔터', market: 'KOSPI' },
  { code: '122870', name: '와이지엔터테인먼트', sector: '엔터', market: 'KOSPI' },
  { code: '035900', name: 'JYP Ent.', sector: '엔터', market: 'KOSPI' },
  { code: '047560', name: 'CJ CGV', sector: '미디어', market: 'KOSPI' },
  
  // 철강/소재
  { code: '005490', name: 'POSCO홀딩스', sector: '철강', market: 'KOSPI' },
  { code: '010130', name: '고려아연', sector: '소재', market: 'KOSPI' },
  { code: '004020', name: '현대제철', sector: '철강', market: 'KOSPI' },
  
  // 건설
  { code: '000720', name: '현대건설', sector: '건설', market: 'KOSPI' },
  { code: '047040', name: '대우건설', sector: '건설', market: 'KOSPI' },
  { code: '034300', name: '신세계건설', sector: '건설', market: 'KOSPI' },
  
  // 유통/소비재
  { code: '004170', name: '신세계', sector: '유통', market: 'KOSPI' },
  { code: '139480', name: '이마트', sector: '유통', market: 'KOSPI' },
  { code: '023530', name: '롯데쇼핑', sector: '유통', market: 'KOSPI' },
  { code: '090460', name: '비에이치', sector: '소비재', market: 'KOSDAQ' },
  
  // 에너지/화학
  { code: '010950', name: 'S-Oil', sector: '에너지', market: 'KOSPI' },
  { code: '096770', name: 'SK이노베이션', sector: '에너지', market: 'KOSPI' },
  { code: '051900', name: 'LG생활건강', sector: '화학', market: 'KOSPI' },
  { code: '090430', name: '아모레퍼시픽', sector: '화학', market: 'KOSPI' },
  
  // IT/소프트웨어
  { code: '035900', name: 'JYP Ent.', sector: 'IT', market: 'KOSPI' },
  { code: '036570', name: '엔씨소프트', sector: 'IT', market: 'KOSPI' },
  { code: '259960', name: '크래프톤', sector: 'IT', market: 'KOSPI' },
  { code: '263750', name: '펫프렌즈', sector: 'IT', market: 'KOSDAQ' },
  { code: '039030', name: '이오테크닉스', sector: 'IT', market: 'KOSDAQ' },
  
  // 방산/항공
  { code: '012450', name: '한화에어로스페이스', sector: '방산', market: 'KOSPI' },
  { code: '047810', name: '한국항공우주', sector: '방산', market: 'KOSPI' },
  { code: '079550', name: 'LIG넥스원', sector: '방산', market: 'KOSPI' },
  { code: '280360', name: '롤스로이스', sector: '항공', market: 'KOSDAQ' },
  
  // 코스닥 대장주
  { code: '298040', name: '효성중공업', sector: '중공업', market: 'KOSPI' },
  { code: '329180', name: 'HD현대일렉트릭', sector: '중공업', market: 'KOSPI' },
  { code: '011790', name: 'SKC', sector: '화학', market: 'KOSPI' },
  { code: '006260', name: 'LS', sector: '전기전자', market: 'KOSPI' },
  { code: '009830', name: '한화솔루션', sector: '태양광', market: 'KOSPI' },
  { code: '375500', name: 'DL이앤씨', sector: '건설', market: 'KOSPI' },
  
  // ETF
  { code: '069500', name: 'KODEX 200', sector: 'ETF', market: 'KOSPI' },
  { code: '229200', name: 'KODEX 코스닥150', sector: 'ETF', market: 'KOSPI' },
  { code: '114800', name: 'TIGER 은행', sector: 'ETF', market: 'KOSPI' },
  { code: '123310', name: 'TIGER 2차전지테마', sector: 'ETF', market: 'KOSPI' },
  { code: '305720', name: 'TIGER 반도체TOP10', sector: 'ETF', market: 'KOSPI' },
  { code: '364970', name: 'ACE 미국S&P500', sector: 'ETF', market: 'KOSPI' },
  { code: '433980', name: 'ACE 나스닥100', sector: 'ETF', market: 'KOSPI' },
];

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') || '';
    const limit = parseInt(searchParams.get('limit') || '20');

    if (!query || query.length < 1) {
      return NextResponse.json({ 
        success: true, 
        data: [],
        total: 0,
      });
    }

    const lowerQuery = query.toLowerCase();

    // 종목명 또는 종목코드로 검색
    const results = STOCK_DATABASE.filter(stock => 
      stock.name.toLowerCase().includes(lowerQuery) ||
      stock.code.includes(query) ||
      stock.sector.toLowerCase().includes(lowerQuery)
    ).slice(0, limit);

    return NextResponse.json({ 
      success: true, 
      data: results,
      total: results.length,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '종목 검색 실패' },
      { status: 500 }
    );
  }
}
