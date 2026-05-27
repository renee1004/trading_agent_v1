// 종목 마스터 통합 정규화 모듈
// 국내/해외 전체 KIS 종목 마스터 기반 정규화 + 검색
//
// 데이터 소스:
// 해외: data/overseas-symbols.json (12,161종목 - KIS COD 파일에서 생성)
// 국내: data/korean-stocks.json (4,456종목 - KRX 마스터 파일에서 생성)
//
// 원본: renee1004/Trading_Agent → trading_agent_v1 포팅
// 해외 COD → JSON 변환: scripts/build-overseas-symbols.mjs

import koreanStocksData from '../../data/korean-stocks.json';
import {
  findOverseasMasterItem,
  normalizeOverseasDisplayCode,
  searchOverseasMaster,
  getOverseasMasterExchangeCode,
  getExplicitOverseasExchangeCode,
  stripOverseasExchangeSuffix as _stripOverseasExchangeSuffix,
  type OverseasExchangeCode,
  type OverseasMasterItem,
} from './kis-overseas-master';

// 재수출: signals/route.ts 등에서 stock-master만 import해도 사용 가능
export type { OverseasExchangeCode } from './kis-overseas-master';

export type DashboardMarket = 'DOMESTIC' | 'OVERSEAS' | 'UNKNOWN';

export type StockMasterItem = {
  market: DashboardMarket;
  exchangeCode: string;
  symbol: string;
  displayCode: string;
  stockName: string;
  currency: 'KRW' | 'USD';
  source: 'DOMESTIC_CODE' | 'DOMESTIC_MASTER' | 'OVERSEAS_MASTER' | 'OVERSEAS_FALLBACK' | 'UNKNOWN';
  /** 한글 종목명 (마스터 데이터에 있을 경우) */
  koreanName?: string;
  /** 영문 종목명 (마스터 데이터에 있을 경우) */
  englishName?: string;
};

// ─── 국내 종목 마스터 JSON 타입 (korean-stocks.json 포맷) ───
type KoreanStockEntry = {
  code: string;           // "005930", "F70100026" 등
  symbol: string;         // "005930.KS", "F70100026.KS" 등
  standardCode?: string;  // "KR7005930009"
  name: string;           // "삼성전자"
  nameEn?: string;        // 영문명 (있을 경우)
  market: string;         // "KOSPI", "KOSDAQ", "KONEX"
  venue?: string;         // "MAIN"
  type: string;           // "EQUITY", "ETF" 등
  source: string;         // "kospi_code.mst", "kosdaq_code.mst" 등
};

// ─── 국내 마스터 인덱스 구축 ───
const KOREAN_STOCK_ITEMS: KoreanStockEntry[] = koreanStocksData as KoreanStockEntry[];

/** 6자리 종목코드 추출 (code에서 순수 6자리 부분) */
function extractSixDigitCode(code: string): string | null {
  const match = code.match(/^(\d{6})/);
  return match ? match[1] : null;
}

/** 검색/정규화에 사용할 국내 종목 인덱스 (6자리 코드 기준) */
interface DomesticIndexEntry {
  symbol: string;       // 6자리 종목코드 "005930"
  displayCode: string;  // "KRX:005930"
  stockName: string;    // "삼성전자"
  market: string;       // "KOSPI" | "KOSDAQ" | "KONEX"
  exchangeCode: string; // "KRX"
  currency: string;     // "KRW"
}

const DOMESTIC_MASTER_ITEMS: DomesticIndexEntry[] = [];
const DOMESTIC_MASTER_BY_SYMBOL = new Map<string, DomesticIndexEntry>();
const DOMESTIC_MASTER_BY_NAME = new Map<string, DomesticIndexEntry>();

for (const entry of KOREAN_STOCK_ITEMS) {
  const sixDigit = extractSixDigitCode(entry.code);
  if (!sixDigit) continue; // 6자리 코드 추출 불가한 항목(ETF F코드 등)은 건너뜀

  const displayCode = `KRX:${sixDigit}`;
  // 동일 6자리 코드가 이미 있으면 건너뜀 (첫 번째 항목 우선 - 보통 보통주)
  if (DOMESTIC_MASTER_BY_SYMBOL.has(sixDigit)) continue;

  const indexEntry: DomesticIndexEntry = {
    symbol: sixDigit,
    displayCode,
    stockName: entry.name,
    market: entry.market,
    exchangeCode: 'KRX',
    currency: 'KRW',
  };

  DOMESTIC_MASTER_ITEMS.push(indexEntry);
  DOMESTIC_MASTER_BY_SYMBOL.set(sixDigit, indexEntry);
  if (!DOMESTIC_MASTER_BY_NAME.has(entry.name)) {
    DOMESTIC_MASTER_BY_NAME.set(entry.name, indexEntry);
  }
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isDomesticStockCode(code: string): boolean {
  const normalized = normalizeCode(code).replace(/^KRX:/, '').replace(/\.(KS|KQ)$/, '');
  return /^\d{6}$/.test(normalized);
}

/**
 * 국내 종목코드 정규화 (JSON 마스터 우선 → 코드 기반 fallback)
 */
export function normalizeDomesticStockCode(code: string): StockMasterItem {
  const symbol = normalizeCode(code).replace(/^KRX:/, '').replace(/\.(KS|KQ)$/, '');

  // JSON 마스터에서 종목명 조회
  const masterEntry = DOMESTIC_MASTER_BY_SYMBOL.get(symbol);
  const stockName = masterEntry?.stockName || symbol;

  return {
    market: 'DOMESTIC',
    exchangeCode: 'KRX',
    symbol,
    displayCode: `KRX:${symbol}`,
    stockName,
    currency: 'KRW',
    source: masterEntry ? 'DOMESTIC_MASTER' : 'DOMESTIC_CODE',
    koreanName: masterEntry?.stockName,
  };
}

/**
 * 해외 종목코드 정규화 (kis-overseas-master.ts 위임, JSON 마스터 포함)
 */
export function normalizeOverseasStockCode(
  code: string,
  fallbackExchange: OverseasExchangeCode = 'NAS',
): StockMasterItem {
  const normalized = normalizeOverseasDisplayCode(code, fallbackExchange);
  const master = findOverseasMasterItem(normalized.symbol);

  return {
    market: 'OVERSEAS',
    exchangeCode: normalized.exchangeCode,
    symbol: normalized.symbol,
    displayCode: normalized.displayCode,
    stockName: master?.koreanName || master?.englishName || master?.name || normalized.symbol,
    currency: 'USD',
    source: master ? 'OVERSEAS_MASTER' : 'OVERSEAS_FALLBACK',
    koreanName: master?.koreanName,
    englishName: master?.englishName || master?.name,
  };
}

/**
 * 국내/해외 자동 판별 정규화
 * 6자리 숫자 → 국내, 그 외 → 해외
 */
export function normalizeDashboardStockCode(
  code: string,
  fallbackExchange: OverseasExchangeCode = 'NAS',
): StockMasterItem {
  const normalized = normalizeCode(code);

  if (!normalized) {
    return {
      market: 'UNKNOWN',
      exchangeCode: '',
      symbol: '',
      displayCode: '',
      stockName: '',
      currency: 'USD',
      source: 'UNKNOWN',
    };
  }

  if (isDomesticStockCode(normalized)) {
    return normalizeDomesticStockCode(normalized);
  }

  return normalizeOverseasStockCode(normalized, fallbackExchange);
}

export function dedupeStockMasterItems(items: StockMasterItem[]): StockMasterItem[] {
  return Array.from(
    new Map(
      items
        .filter((item) => item.displayCode)
        .map((item) => [item.displayCode, item]),
    ).values(),
  );
}

export function normalizeDashboardStockCodes(codes: string[]): StockMasterItem[] {
  return dedupeStockMasterItems(codes.map((code) => normalizeDashboardStockCode(code)));
}

// ─── 통합 검색 ───

export type StockSearchResult = {
  market: DashboardMarket;
  exchangeCode: string;
  symbol: string;
  displayCode: string;
  stockName: string;
  koreanName?: string;
  englishName?: string;
  currency: 'KRW' | 'USD';
  source: 'DOMESTIC_MASTER' | 'KIS_OVERSEAS_MASTER' | 'OVERSEAS_FALLBACK';
};

/**
 * 국내+해외 통합 종목 검색 (로컬 마스터만 사용, KIS API 호출 없음)
 *
 * 검색 대상:
 * - 국내: 종목코드(6자리), 종목명(name), 마켓명(market)
 * - 해외: 티커(symbol), 한글명(koreanName), 영문명(englishName)
 * - displayCode, 거래소 코드
 */
export function searchAllStocks(
  query: string,
  limit: number = 30,
): StockSearchResult[] {
  if (!query || query.length < 1) return [];

  const results: StockSearchResult[] = [];
  const seenDisplayCodes = new Set<string>();
  const upperQuery = query.toUpperCase();
  const lowerQuery = query.toLowerCase();

  // ─── 국내 검색 ───
  for (const entry of DOMESTIC_MASTER_ITEMS) {
    if (seenDisplayCodes.has(entry.displayCode)) continue;

    const matches =
      entry.symbol.includes(query) ||
      entry.symbol.includes(upperQuery) ||
      entry.stockName.includes(query) ||
      entry.displayCode.toUpperCase().includes(upperQuery) ||
      entry.market.toUpperCase().includes(upperQuery) ||
      entry.exchangeCode.toUpperCase().includes(upperQuery);

    if (matches) {
      seenDisplayCodes.add(entry.displayCode);
      results.push({
        market: 'DOMESTIC',
        exchangeCode: 'KRX',
        symbol: entry.symbol,
        displayCode: entry.displayCode,
        stockName: entry.stockName,
        koreanName: entry.stockName,
        currency: 'KRW',
        source: 'DOMESTIC_MASTER',
      });
    }
  }

  // 국내 정렬: 정확히 일치 → 접두사 일치 → 나머지
  results.sort((a, b) => {
    const aExact = a.symbol === query || a.symbol === upperQuery ? 0 : a.symbol.startsWith(query) || a.symbol.startsWith(upperQuery) ? 1 : 2;
    const bExact = b.symbol === query || b.symbol === upperQuery ? 0 : b.symbol.startsWith(query) || b.symbol.startsWith(upperQuery) ? 1 : 2;
    return aExact - bExact;
  });

  // ─── 해외 검색 (kis-overseas-master의 searchOverseasMaster 사용) ───
  if (results.length < limit) {
    const overseasResults = searchOverseasMaster(query, limit - results.length);
    for (const item of overseasResults) {
      if (results.length >= limit) break;

      const displayCode = `${item.exchange}:${item.symbol}`;
      if (seenDisplayCodes.has(displayCode)) continue;

      seenDisplayCodes.add(displayCode);
      results.push({
        market: 'OVERSEAS',
        exchangeCode: item.exchange,
        symbol: item.symbol,
        displayCode,
        stockName: item.koreanName || item.englishName || item.name || item.symbol,
        koreanName: item.koreanName,
        englishName: item.englishName || item.name,
        currency: 'USD',
        source: 'KIS_OVERSEAS_MASTER',
      });
    }
  }

  // ─── displayCode로도 검색 (예: "NAS:NVDA", "KRX:005930") ───
  if (results.length < limit && upperQuery.includes(':')) {
    const [prefix, sym] = upperQuery.split(':');
    if (prefix && sym) {
      // 이미 위에서 검색되었을 가능성이 높지만, 누락 시 보완
      const normalized = normalizeDashboardStockCode(query);
      if (normalized.displayCode && !seenDisplayCodes.has(normalized.displayCode)) {
        seenDisplayCodes.add(normalized.displayCode);
        results.push({
          market: normalized.market,
          exchangeCode: normalized.exchangeCode,
          symbol: normalized.symbol,
          displayCode: normalized.displayCode,
          stockName: normalized.stockName,
          koreanName: normalized.koreanName,
          englishName: normalized.englishName,
          currency: normalized.currency as 'KRW' | 'USD',
          source: normalized.source as StockSearchResult['source'],
        });
      }
    }
  }

  return results;
}

// ─── 마스터 사이즈 조회 ───

export function getDomesticMasterSize(): number {
  return DOMESTIC_MASTER_ITEMS.length;
}

/** 국내 종목명으로 symbol 조회 */
export function findDomesticSymbolByName(name: string): string | undefined {
  const entry = DOMESTIC_MASTER_BY_NAME.get(name);
  return entry?.symbol;
}

/** 국내 symbol로 종목명 조회 */
export function findDomesticNameBySymbol(symbol: string): string | undefined {
  const entry = DOMESTIC_MASTER_BY_SYMBOL.get(symbol);
  return entry?.stockName;
}

// ─── 실시간 현재가 보강용 유틸리티 (원본 Trading_Agent에서 포팅) ───
// route.ts의 enrichSignalWithQuote에서 사용

const FALLBACK_EXCD_SEQUENCE: OverseasExchangeCode[] = ['NAS', 'NYS', 'AMS'];

/**
 * 국내/해외 자동 판별
 * 원본: isKorean (app/api/kis/price/route.ts)
 *
 * 국내: 6자리 숫자, .KS, .KQ, KRX: 접두사
 * 해외: 그 외 모든 심볼
 */
export function isKoreanSymbol(symbol: string): boolean {
  return isDomesticStockCode(symbol) ||
    symbol.trim().endsWith('.KS') ||
    symbol.trim().endsWith('.KQ');
}

/**
 * 종목코드에서 순수 코드만 추출
 * 국내: "KRX:005930" → "005930", "005930.KS" → "005930"
 * 해외: "NAS:NVDA" → "NVDA", "NVDA.NAS" → "NVDA"
 */
export function normalizeStockCode(symbol: string): string {
  // 국내: KRX: 접두사 제거
  const withoutKrx = symbol.replace(/^KRX:/i, '');
  // 국내: .KS/.KQ 접미사 제거
  const withoutKs = withoutKrx.replace(/\.KS$/, '').replace(/\.KQ$/, '');
  // 해외: 거래소 접미사 제거
  if (!isKoreanSymbol(symbol)) {
    return _stripOverseasExchangeSuffix(withoutKs);
  }
  return withoutKs;
}

/**
 * 해외 종목의 거래소 코드 종합 판별
 * 우선순위: 명시적 접미사 → 마스터 테이블 → 기본값 NAS
 * 원본: getExcd (overseas.ts)
 */
export function getOverseasExchangeCode(symbol: string): OverseasExchangeCode {
  const pureSymbol = _stripOverseasExchangeSuffix(symbol);

  return (
    getExplicitOverseasExchangeCode(symbol) ??
    getOverseasMasterExchangeCode(symbol) ??
    'NAS'
  );
}

/**
 * 해외 종목의 거래소 후보 목록 반환 (fallback 시퀀스)
 * 원본: getExcdCandidates
 */
export function getOverseasExchangeCandidates(symbol: string): OverseasExchangeCode[] {
  const first = getOverseasExchangeCode(symbol);
  return [...new Set([first, ...FALLBACK_EXCD_SEQUENCE])];
}

/**
 * 거래소 접미사를 제거한 순수 심볼 반환 (kis-overseas-master.ts에서 재수출)
 * 예: "NAS:NVDA" → "NVDA", "SPY.AMS" → "SPY"
 */
export const stripOverseasExchangeSuffix = _stripOverseasExchangeSuffix;
