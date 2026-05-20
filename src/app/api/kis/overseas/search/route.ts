// 해외주식 종목 검색 API
// 미국 나스닥/뉴욕/아멕스 종목 검색

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

// 미국 주요 종목 데이터베이스
const US_STOCK_DATABASE = [
  // 기술주 (Big Tech)
  { code: 'AAPL', name: '애플', nameEng: 'Apple Inc.', exchangeCode: 'NAS', sector: '기술', market: '나스닥' },
  { code: 'MSFT', name: '마이크로소프트', nameEng: 'Microsoft Corp.', exchangeCode: 'NAS', sector: '기술', market: '나스닥' },
  { code: 'GOOGL', name: '알파벳 A', nameEng: 'Alphabet Inc.', exchangeCode: 'NAS', sector: '기술', market: '나스닥' },
  { code: 'GOOG', name: '알파벳 C', nameEng: 'Alphabet Inc. Class C', exchangeCode: 'NAS', sector: '기술', market: '나스닥' },
  { code: 'AMZN', name: '아마존', nameEng: 'Amazon.com Inc.', exchangeCode: 'NAS', sector: '기술', market: '나스닥' },
  { code: 'NVDA', name: '엔비디아', nameEng: 'NVIDIA Corp.', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  { code: 'META', name: '메타', nameEng: 'Meta Platforms Inc.', exchangeCode: 'NAS', sector: '기술', market: '나스닥' },
  { code: 'TSLA', name: '테슬라', nameEng: 'Tesla Inc.', exchangeCode: 'NAS', sector: '자동차', market: '나스닥' },
  
  // 반도체
  { code: 'AMD', name: 'AMD', nameEng: 'Advanced Micro Devices', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  { code: 'INTC', name: '인텔', nameEng: 'Intel Corp.', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  { code: 'AVGO', name: '브로드컴', nameEng: 'Broadcom Inc.', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  { code: 'QCOM', name: '퀄컴', nameEng: 'Qualcomm Inc.', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  { code: 'TXN', name: '텍사스인스트루먼트', nameEng: 'Texas Instruments', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  { code: 'MU', name: '마이크론', nameEng: 'Micron Technology', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  { code: 'ARM', name: 'ARM홀딩스', nameEng: 'ARM Holdings', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  { code: 'SNPS', name: '시놉시스', nameEng: 'Synopsys Inc.', exchangeCode: 'NAS', sector: '반도체', market: '나스닥' },
  
  // 소프트웨어/클라우드
  { code: 'CRM', name: '세일즈포스', nameEng: 'Salesforce Inc.', exchangeCode: 'NYS', sector: '소프트웨어', market: '뉴욕' },
  { code: 'ORCL', name: '오라클', nameEng: 'Oracle Corp.', exchangeCode: 'NYS', sector: '소프트웨어', market: '뉴욕' },
  { code: 'ADBE', name: '어도비', nameEng: 'Adobe Inc.', exchangeCode: 'NAS', sector: '소프트웨어', market: '나스닥' },
  { code: 'NOW', name: '서비스나우', nameEng: 'ServiceNow Inc.', exchangeCode: 'NYS', sector: '소프트웨어', market: '뉴욕' },
  { code: 'SNOW', name: '스노우플레이크', nameEng: 'Snowflake Inc.', exchangeCode: 'NYS', sector: '소프트웨어', market: '뉴욕' },
  { code: 'PLTR', name: '팔란티어', nameEng: 'Palantir Technologies', exchangeCode: 'NYS', sector: '소프트웨어', market: '뉴욕' },
  { code: 'UBER', name: '우버', nameEng: 'Uber Technologies', exchangeCode: 'NYS', sector: '플랫폼', market: '뉴욕' },
  { code: 'SQ', name: '블록', nameEng: 'Block Inc.', exchangeCode: 'NYS', sector: '핀테크', market: '뉴욕' },
  
  // 금융
  { code: 'JPM', name: 'JP모건', nameEng: 'JPMorgan Chase', exchangeCode: 'NYS', sector: '금융', market: '뉴욕' },
  { code: 'BAC', name: '뱅크오브아메리카', nameEng: 'Bank of America', exchangeCode: 'NYS', sector: '금융', market: '뉴욕' },
  { code: 'GS', name: '골드만삭스', nameEng: 'Goldman Sachs', exchangeCode: 'NYS', sector: '금융', market: '뉴욕' },
  { code: 'V', name: '비자', nameEng: 'Visa Inc.', exchangeCode: 'NYS', sector: '금융', market: '뉴욕' },
  { code: 'MA', name: '마스터카드', nameEng: 'Mastercard Inc.', exchangeCode: 'NYS', sector: '금융', market: '뉴욕' },
  { code: 'PYPL', name: '페이팔', nameEng: 'PayPal Holdings', exchangeCode: 'NAS', sector: '핀테크', market: '나스닥' },
  
  // 헬스케어/바이오
  { code: 'UNH', name: '유나이티드헬스', nameEng: 'UnitedHealth Group', exchangeCode: 'NYS', sector: '헬스케어', market: '뉴욕' },
  { code: 'JNJ', name: '존슨앤드존슨', nameEng: 'Johnson & Johnson', exchangeCode: 'NYS', sector: '헬스케어', market: '뉴욕' },
  { code: 'LLY', name: '일라이릴리', nameEng: 'Eli Lilly', exchangeCode: 'NYS', sector: '제약', market: '뉴욕' },
  { code: 'PFE', name: '화이자', nameEng: 'Pfizer Inc.', exchangeCode: 'NYS', sector: '제약', market: '뉴욕' },
  { code: 'MRK', name: '머크', nameEng: 'Merck & Co.', exchangeCode: 'NYS', sector: '제약', market: '뉴욕' },
  { code: 'MRNA', name: '모더나', nameEng: 'Moderna Inc.', exchangeCode: 'NAS', sector: '바이오', market: '나스닥' },
  
  // 소비재/리테일
  { code: 'WMT', name: '월마트', nameEng: 'Walmart Inc.', exchangeCode: 'NYS', sector: '리테일', market: '뉴욕' },
  { code: 'COST', name: '코스트코', nameEng: 'Costco Wholesale', exchangeCode: 'NAS', sector: '리테일', market: '나스닥' },
  { code: 'NKE', name: '나이키', nameEng: 'Nike Inc.', exchangeCode: 'NYS', sector: '소비재', market: '뉴욕' },
  { code: 'SBUX', name: '스타벅스', nameEng: 'Starbucks Corp.', exchangeCode: 'NAS', sector: '소비재', market: '나스닥' },
  { code: 'MCD', name: '맥도날드', nameEng: 'McDonald\'s Corp.', exchangeCode: 'NYS', sector: '소비재', market: '뉴욕' },
  
  // 에너지
  { code: 'XOM', name: '엑손모빌', nameEng: 'Exxon Mobil', exchangeCode: 'NYS', sector: '에너지', market: '뉴욕' },
  { code: 'CVX', name: '쉐브론', nameEng: 'Chevron Corp.', exchangeCode: 'NYS', sector: '에너지', market: '뉴욕' },
  
  // 통신/엔터
  { code: 'NFLX', name: '넷플릭스', nameEng: 'Netflix Inc.', exchangeCode: 'NAS', sector: '엔터', market: '나스닥' },
  { code: 'DIS', name: '디즈니', nameEng: 'Walt Disney Co.', exchangeCode: 'NYS', sector: '엔터', market: '뉴욕' },
  { code: 'CMCSA', name: '컴캐스트', nameEng: 'Comcast Corp.', exchangeCode: 'NAS', sector: '통신', market: '나스닥' },
  
  // 산업재
  { code: 'CAT', name: '캐터필라', nameEng: 'Caterpillar Inc.', exchangeCode: 'NYS', sector: '산업재', market: '뉴욕' },
  { code: 'GE', name: 'GE헬스케어', nameEng: 'GE Aerospace', exchangeCode: 'NYS', sector: '산업재', market: '뉴욕' },
  
  // ETF
  { code: 'SPY', name: 'SPDR S&P500 ETF', nameEng: 'SPDR S&P 500 ETF', exchangeCode: 'AMS', sector: 'ETF', market: '아멕스' },
  { code: 'QQQ', name: '인빅스 나스닥100 ETF', nameEng: 'Invesco QQQ ETF', exchangeCode: 'NAS', sector: 'ETF', market: '나스닥' },
  { code: 'IWM', name: 'iShares 러셀2000 ETF', nameEng: 'iShares Russell 2000 ETF', exchangeCode: 'AMS', sector: 'ETF', market: '아멕스' },
  { code: 'VTI', name: '뱅가드 토탈스톡 ETF', nameEng: 'Vanguard Total Stock ETF', exchangeCode: 'AMS', sector: 'ETF', market: '아멕스' },
  { code: 'VOO', name: '뱅가드 S&P500 ETF', nameEng: 'Vanguard S&P 500 ETF', exchangeCode: 'AMS', sector: 'ETF', market: '아멕스' },
  
  // 우주/항공우주 (Space & Aerospace)
  { code: 'RKLB', name: '로켓랩', nameEng: 'Rocket Lab USA Inc.', exchangeCode: 'NAS', sector: '우주', market: '나스닥' },
  { code: 'LUNR', name: '인튜이티브 머신스', nameEng: 'Intuitive Machines Inc.', exchangeCode: 'NAS', sector: '우주', market: '나스닥' },
  { code: 'ASTR', name: '아스트라 스페이스', nameEng: 'Astra Space Inc.', exchangeCode: 'NAS', sector: '우주', market: '나스닥' },
  { code: 'ASTS', name: 'AST 스페이스모빌', nameEng: 'AST SpaceMobile Inc.', exchangeCode: 'NAS', sector: '우주', market: '나스닥' },
  { code: 'SPCE', name: '버진 갤럭틱', nameEng: 'Virgin Galactic Holdings', exchangeCode: 'NYS', sector: '우주', market: '뉴욕' },
  { code: 'JOBY', name: '조비 에비에이션', nameEng: 'Joby Aviation Inc.', exchangeCode: 'NYS', sector: '우주', market: '뉴욕' },
  { code: 'EVTL', name: '베티칼 에어스', nameEng: 'Vertical Aerospace Ltd.', exchangeCode: 'NYS', sector: '우주', market: '뉴욕' },
  { code: 'BA', name: '보잉', nameEng: 'Boeing Co.', exchangeCode: 'NYS', sector: '항공우주', market: '뉴욕' },
  { code: 'LMT', name: '록히드마틴', nameEng: 'Lockheed Martin Corp.', exchangeCode: 'NYS', sector: '항공우주', market: '뉴욕' },
  { code: 'RTX', name: 'RTX코퍼레이션', nameEng: 'RTX Corp.', exchangeCode: 'NYS', sector: '항공우주', market: '뉴욕' },
  { code: 'NOC', name: '노스롭그루먼', nameEng: 'Northrop Grumman Corp.', exchangeCode: 'NYS', sector: '항공우주', market: '뉴욕' },
  { code: 'GD', name: '제너럴 다이내믹스', nameEng: 'General Dynamics Corp.', exchangeCode: 'NYS', sector: '항공우주', market: '뉴욕' },
  { code: 'TDG', name: '트랜스다임', nameEng: 'TransDigm Group Inc.', exchangeCode: 'NYS', sector: '항공우주', market: '뉴욕' },
  { code: 'UFO', name: 'PROCURE UFO ETF', nameEng: 'Procure Space ETF', exchangeCode: 'NAS', sector: '우주ETF', market: '나스닥' },
  
  // AI/로봇
  { code: 'PLTR', name: '팔란티어', nameEng: 'Palantir Technologies', exchangeCode: 'NYS', sector: 'AI', market: '뉴욕' },
  { code: 'SNOW', name: '스노우플레이크', nameEng: 'Snowflake Inc.', exchangeCode: 'NYS', sector: '데이터', market: '뉴욕' },
  { code: 'AI', name: 'C3.ai', nameEng: 'C3.ai Inc.', exchangeCode: 'NYS', sector: 'AI', market: '뉴욕' },
  { code: 'SOUN', name: '사운드하운드AI', nameEng: 'SoundHound AI Inc.', exchangeCode: 'NAS', sector: 'AI', market: '나스닥' },
  { code: 'SERV', name: '서브로크AI', nameEng: 'Serve Robotics Inc.', exchangeCode: 'NAS', sector: '로봇', market: '나스닥' },
  { code: 'PATH', name: 'UiPath', nameEng: 'UiPath Inc.', exchangeCode: 'NYS', sector: '로봇', market: '뉴욕' },
  { code: 'ISRG', name: '인튜이티브 서지컬', nameEng: 'Intuitive Surgical Inc.', exchangeCode: 'NAS', sector: '로봇', market: '나스닥' },
  
  // 전기차/클린에너지
  { code: 'RIVN', name: '리비안', nameEng: 'Rivian Automotive', exchangeCode: 'NAS', sector: '전기차', market: '나스닥' },
  { code: 'LCID', name: '루시드 모터스', nameEng: 'Lucid Group Inc.', exchangeCode: 'NAS', sector: '전기차', market: '나스닥' },
  { code: 'F', name: '포드', nameEng: 'Ford Motor Co.', exchangeCode: 'NYS', sector: '자동차', market: '뉴욕' },
  { code: 'GM', name: '제너럴모터스', nameEng: 'General Motors Co.', exchangeCode: 'NYS', sector: '자동차', market: '뉴욕' },
  { code: 'ENPH', name: '엔페이즈 에너지', nameEng: 'Enphase Energy Inc.', exchangeCode: 'NAS', sector: '태양광', market: '나스닥' },
  { code: 'SEDG', name: '솔라에지', nameEng: 'SolarEdge Technologies', exchangeCode: 'NAS', sector: '태양광', market: '나스닥' },
  
  // 암호화폐/블록체인
  { code: 'COIN', name: '코인베이스', nameEng: 'Coinbase Global Inc.', exchangeCode: 'NAS', sector: '블록체인', market: '나스닥' },
  { code: 'MSTR', name: '마이크로스트래티지', nameEng: 'MicroStrategy Inc.', exchangeCode: 'NAS', sector: '블록체인', market: '나스닥' },
  { code: 'RIOT', name: '리오트 플랫폼', nameEng: 'Riot Platforms Inc.', exchangeCode: 'NAS', sector: '블록체인', market: '나스닥' },
  { code: 'CLSK', name: '클린스파크', nameEng: 'CleanSpark Inc.', exchangeCode: 'NAS', sector: '블록체인', market: '나스닥' },
  
  // 사이버보안
  { code: 'CRWD', name: '크라우드스트라이크', nameEng: 'CrowdStrike Holdings', exchangeCode: 'NAS', sector: '사이버보안', market: '나스닥' },
  { code: 'PANW', name: '팔로알토네트웍스', nameEng: 'Palo Alto Networks', exchangeCode: 'NAS', sector: '사이버보안', market: '나스닥' },
  { code: 'ZS', name: '즈케일러', nameEng: 'Zscaler Inc.', exchangeCode: 'NAS', sector: '사이버보안', market: '나스닥' },
  { code: 'FTNT', name: '포티넷', nameEng: 'Fortinet Inc.', exchangeCode: 'NAS', sector: '사이버보안', market: '나스닥' },
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

    const upperQuery = query.toUpperCase();
    const lowerQuery = query.toLowerCase();

    // 한글-영문 섹터 매핑 (한글로 검색해도 영문 섹터명과 매칭)
    const sectorAliases: Record<string, string[]> = {
      '우주': ['space', '우주', '항공우주'],
      '우주주': ['space', '우주', '항공우주'],
      '항공우주': ['aerospace', '우주', '항공우주'],
      '방산': ['defense', '항공우주'],
      '인공지능': ['ai', '인공지능'],
      '로봇': ['robot', '로봇'],
      '전기차': ['ev', '전기차'],
      '블록체인': ['blockchain', '블록체인'],
      '암호화폐': ['crypto', '블록체인'],
      '보안': ['security', '사이버보안'],
      '사이버': ['cyber', '사이버보안'],
      '태양광': ['solar', '태양광'],
    };

    // 검색어에 매칭되는 추가 섹터 키워드
    const extraSectorKeywords: string[] = [];
    for (const [keyword, aliases] of Object.entries(sectorAliases)) {
      if (lowerQuery.includes(keyword) || aliases.some(a => lowerQuery.includes(a.toLowerCase()))) {
        extraSectorKeywords.push(...aliases);
      }
    }

    // 1. 먼저 로컬 DB에서 검색
    const localResults = US_STOCK_DATABASE.filter(stock => {
      const matchesBasic = 
        stock.code.toUpperCase().includes(upperQuery) ||
        stock.name.toLowerCase().includes(lowerQuery) ||
        stock.nameEng.toLowerCase().includes(lowerQuery) ||
        stock.sector.toLowerCase().includes(lowerQuery) ||
        stock.market.includes(query);
      
      const matchesSectorAlias = extraSectorKeywords.some(keyword => 
        stock.sector.toLowerCase().includes(keyword.toLowerCase()) ||
        stock.nameEng.toLowerCase().includes(keyword.toLowerCase()) ||
        stock.name.toLowerCase().includes(keyword)
      );
      
      return matchesBasic || matchesSectorAlias;
    }).slice(0, limit);

    // 2. KIS API 연결 시 API 검색도 시도
    if (localResults.length < limit) {
      const config = await db.kisConfig.findFirst();
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

          // 나스닥과 뉴욕 모두 검색
          const exchanges = ['NAS', 'NYS'];
          for (const excd of exchanges) {
            if (localResults.length >= limit) break;
            try {
              const apiResults = await client.searchOverseasStock(query, excd);
              for (const item of apiResults) {
                if (localResults.length >= limit) break;
                if (!localResults.some(r => r.code === item.code)) {
                  localResults.push({
                    code: item.code,
                    name: item.name || item.nameEng,
                    nameEng: item.nameEng,
                    exchangeCode: item.exchangeCode,
                    sector: item.sector,
                    market: excd === 'NAS' ? '나스닥' : excd === 'NYS' ? '뉴욕' : excd,
                  });
                }
              }
            } catch {
              // API 검색 실패 시 무시
            }
          }
        } catch {
          // KIS API 오류 시 로컬 결과만 반환
        }
      }
    }

    return NextResponse.json({ 
      success: true, 
      data: localResults,
      total: localResults.length,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: '해외주식 검색 실패' },
      { status: 500 }
    );
  }
}
