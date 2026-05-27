// 자동 후보 종목 발굴 모듈
// 관심종목 + 보유종목 + 우량 대형주 풀을 결합하여 분석 대상 선정
// KIS 모의투자 API 제약으로 인해 거래대금 상위 직접 조회가 어려워
// 사전 정의된 우량주 풀 + 동적 관심종목 + 보유종목 방식 사용
//
// 스코어링: 보유종목 > 관심종목 > 우량주 순으로 우선순위 부여
// Top-N: API 호출 한도 보호를 위해 국내/해외 각각 최대 종목 수 제한

import { db } from './db';
import { KisApiClient } from './kis-api';
import { normalizeStockCode } from './stock-master';

/**
 * 국내 우량 대형주 풀 (거래대금 상위 + 시가총액 상위 기준)
 * 에이전트가 항상 분석 대상으로 포함하는 기본 종목
 */
const DOMESTIC_BLUE_CHIPS: Array<{ code: string; name: string }> = [
  { code: '005930', name: '삼성전자' },
  { code: '000660', name: 'SK하이닉스' },
  { code: '373220', name: 'LG에너지솔루션' },
  { code: '005380', name: '현대차' },
  { code: '035420', name: 'NAVER' },
  { code: '006400', name: '삼성SDI' },
  { code: '051910', name: 'LG화학' },
  { code: '005490', name: 'POSCO홀딩스' },
  { code: '035720', name: '카카오' },
  { code: '000270', name: '기아' },
  { code: '068270', name: '셀트리온' },
  { code: '003670', name: '포스코퓨처엠' },
  { code: '066570', name: 'LG전자' },
  { code: '012330', name: '현대모비스' },
  { code: '009830', name: '한화에어로스페이스' },
];

/**
 * 해외 우량 대형주 풀 (거래대금 상위 기준)
 */
const OVERSEAS_BLUE_CHIPS: Array<{ code: string; name: string; exchange: string }> = [
  { code: 'AAPL', name: 'Apple', exchange: 'NAS' },
  { code: 'MSFT', name: 'Microsoft', exchange: 'NAS' },
  { code: 'GOOGL', name: 'Alphabet', exchange: 'NAS' },
  { code: 'AMZN', name: 'Amazon', exchange: 'NAS' },
  { code: 'NVDA', name: 'NVIDIA', exchange: 'NAS' },
  { code: 'TSLA', name: 'Tesla', exchange: 'NAS' },
  { code: 'META', name: 'Meta', exchange: 'NAS' },
];

/**
 * 종목 출처에 따른 우선순위 스코어
 * 보유종목이 가장 높은 우선순위 (반드시 모니터링해야 하므로)
 * 관심종목이 그 다음 (사용자가 명시적으로 선택)
 * 우량주 풀은 기본 우선순위
 */
const SOURCE_PRIORITY = {
  POSITION: 100,   // 보유종목: 항상 포함
  WATCHLIST: 50,   // 관심종목: 높은 우선순위
  BLUE_CHIP: 10,   // 우량주 풀: 기본 우선순위
} as const;

/** 국내 분석 최대 종목 수 (API 호출 한도 보호) */
const MAX_DOMESTIC_STOCKS = 10;
/** 해외 분석 최대 종목 수 */
const MAX_OVERSEAS_STOCKS = 5;

interface ScoredDomesticStock {
  code: string;
  name: string;
  score: number;
  source: 'POSITION' | 'WATCHLIST' | 'BLUE_CHIP';
}

interface ScoredOverseasStock {
  code: string;
  name: string;
  exchange: string;
  score: number;
  source: 'POSITION' | 'WATCHLIST' | 'BLUE_CHIP';
}

export interface ScanResult {
  domestic: Array<{ code: string; name: string }>;
  overseas: Array<{ code: string; name: string; exchange: string }>;
  sources: {
    watchlist: number;
    positions: number;
    blueChips: number;
  };
  /** 스코어링 후 제외된 종목 수 (API 호출 한도 초과 시) */
  filtered: {
    domesticFiltered: number;
    overseasFiltered: number;
  };
}

/**
 * KIS API를 이용한 동적 종목 스캔
 * 보유종목 + 관심종목 + 우량주 풀을 병합하고 중복 제거 후
 * 우선순위 기반 스코어링으로 Top-N 선정
 *
 * 스코어링 규칙:
 * 1. 보유종목: 항상 포함 (score=100, 무조건 선정)
 * 2. 관심종목: 높은 우선순위 (score=50)
 * 3. 우량주 풀: 기본 우선순위 (score=10)
 * 4. 동점 시 종목코드 오름차순 (안정적 정렬)
 */
export async function scanTargetStocks(
  kisClient: KisApiClient | null
): Promise<ScanResult> {
  const sources = { watchlist: 0, positions: 0, blueChips: 0 };
  const domesticSeen = new Set<string>();
  const overseasSeen = new Set<string>();
  const domesticScored: ScoredDomesticStock[] = [];
  const overseasScored: ScoredOverseasStock[] = [];

  // 1. 보유종목 (실제 포지션이 있으면 반드시 모니터링)
  if (kisClient) {
    try {
      const balance = await kisClient.getAccountBalance();
      for (const pos of balance.positions) {
        const normalizedCode = normalizeStockCode(pos.stockCode);
        if (pos.quantity > 0 && !domesticSeen.has(normalizedCode)) {
          domesticSeen.add(normalizedCode);
          domesticScored.push({
            code: normalizedCode,
            name: pos.stockName,
            score: SOURCE_PRIORITY.POSITION,
            source: 'POSITION',
          });
          sources.positions++;
        }
      }
    } catch (e) {
      // 잔고 조회 실패 시 보유종목 스킵
      console.warn('[Market Scanner] 국내 잔고 조회 실패, 보유종목 스킵');
    }

    try {
      const overseasBalance = await kisClient.getOverseasAccountBalance();
      for (const pos of overseasBalance.positions) {
        const normalizedCode = normalizeStockCode(pos.stockCode);
        if (pos.quantity > 0 && !overseasSeen.has(normalizedCode)) {
          overseasSeen.add(normalizedCode);
          overseasScored.push({
            code: normalizedCode,
            name: pos.stockName,
            exchange: pos.exchangeCode || 'NAS',
            score: SOURCE_PRIORITY.POSITION,
            source: 'POSITION',
          });
          sources.positions++;
        }
      }
    } catch (e) {
      // 해외 잔고 조회 실패 시 스킵
      console.warn('[Market Scanner] 해외 잔고 조회 실패, 보유종목 스킵');
    }
  }

  // 2. 관심종목 (사용자가 명시적으로 추가한 종목)
  try {
    const watchlist = await db.watchlistItem.findMany({
      where: { isActive: true },
    });

    for (const item of watchlist) {
      const normalizedCode = normalizeStockCode(item.stockCode);
      if (item.market === 'DOMESTIC' && !domesticSeen.has(normalizedCode)) {
        domesticSeen.add(normalizedCode);
        domesticScored.push({
          code: normalizedCode,
          name: item.stockName,
          score: SOURCE_PRIORITY.WATCHLIST,
          source: 'WATCHLIST',
        });
        sources.watchlist++;
      } else if (item.market === 'OVERSEAS' && !overseasSeen.has(normalizedCode)) {
        overseasSeen.add(normalizedCode);
        overseasScored.push({
          code: normalizedCode,
          name: item.stockName,
          exchange: item.exchangeCode || 'NAS',
          score: SOURCE_PRIORITY.WATCHLIST,
          source: 'WATCHLIST',
        });
        sources.watchlist++;
      }
    }
  } catch (e) {
    // DB 조회 실패 시 스킵
    console.warn('[Market Scanner] 관심종목 DB 조회 실패, 스킵');
  }

  // 3. 우량 대형주 풀 (관심종목/보유종목에 없는 것만 추가)
  for (const stock of DOMESTIC_BLUE_CHIPS) {
    if (!domesticSeen.has(stock.code)) {
      domesticSeen.add(stock.code);
      domesticScored.push({
        code: stock.code,
        name: stock.name,
        score: SOURCE_PRIORITY.BLUE_CHIP,
        source: 'BLUE_CHIP',
      });
      sources.blueChips++;
    }
  }

  for (const stock of OVERSEAS_BLUE_CHIPS) {
    if (!overseasSeen.has(stock.code)) {
      overseasSeen.add(stock.code);
      overseasScored.push({
        code: stock.code,
        name: stock.name,
        exchange: stock.exchange,
        score: SOURCE_PRIORITY.BLUE_CHIP,
        source: 'BLUE_CHIP',
      });
      sources.blueChips++;
    }
  }

  // 4. 스코어 기반 정렬 후 Top-N 선정
  // 보유종목(100) > 관심종목(50) > 우량주(10) 순으로 정렬
  // 동점 시 종목코드 오름차순 (안정적 정렬 보장)
  domesticScored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
  overseasScored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));

  const totalDomestic = domesticScored.length;
  const totalOverseas = overseasScored.length;

  const domesticSelected = domesticScored.slice(0, MAX_DOMESTIC_STOCKS);
  const overseasSelected = overseasScored.slice(0, MAX_OVERSEAS_STOCKS);

  const domestic = domesticSelected.map(s => ({ code: s.code, name: s.name }));
  const overseas = overseasSelected.map(s => ({ code: s.code, name: s.name, exchange: s.exchange }));

  const filtered = {
    domesticFiltered: Math.max(0, totalDomestic - MAX_DOMESTIC_STOCKS),
    overseasFiltered: Math.max(0, totalOverseas - MAX_OVERSEAS_STOCKS),
  };

  console.log(
    `[Market Scanner] 분석 대상: 국내 ${domestic.length}/${totalDomestic}개, 해외 ${overseas.length}/${totalOverseas}개`,
    { sources, filtered }
  );

  // 필터링된 종목이 있으면 로그 출력
  if (filtered.domesticFiltered > 0 || filtered.overseasFiltered > 0) {
    const excludedDomestic = domesticScored.slice(MAX_DOMESTIC_STOCKS).map(s => s.name);
    const excludedOverseas = overseasScored.slice(MAX_OVERSEAS_STOCKS).map(s => s.name);
    console.log(
      `[Market Scanner] 분석 제외 (우선순위 낮음): 국내 [${excludedDomestic.join(', ')}], 해외 [${excludedOverseas.join(', ')}]`
    );
  }

  return { domestic, overseas, sources, filtered };
}
