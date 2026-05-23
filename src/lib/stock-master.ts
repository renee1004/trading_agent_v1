// 종목 마스터 통합 정규화 모듈
// 국내/해외 전체 KIS 종목 마스터 기반 정규화 + 검색
//
// 데이터 소스 우선순위:
// 해외: data/overseas-symbols.json → kis-overseas-master.ts fallback
// 국내: data/domestic-symbols.json → 기존 6자리 코드 정규화 fallback

import domesticSymbolsData from '../../data/domestic-symbols.json';
import {
  findOverseasMasterItem,
  normalizeOverseasDisplayCode,
  searchOverseasMaster,
  type OverseasExchangeCode,
  type OverseasMasterItem,
} from './kis-overseas-master';

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

// ─── 국내 종목 마스터 JSON 타입 ───
type DomesticSymbolEntry = {
  symbol: string;
  displayCode: string;
  stockName: string;
  market: string;
  exchangeCode: string;
  currency: string;
};

// ─── 국내 마스터 인덱스 ───
const DOMESTIC_MASTER_ITEMS: DomesticSymbolEntry[] =
  domesticSymbolsData as DomesticSymbolEntry[];

const DOMESTIC_MASTER_BY_SYMBOL = new Map<string, DomesticSymbolEntry>();
const DOMESTIC_MASTER_BY_NAME = new Map<string, DomesticSymbolEntry>();

for (const entry of DOMESTIC_MASTER_ITEMS) {
  DOMESTIC_MASTER_BY_SYMBOL.set(entry.symbol, entry);
  // 종목명 → symbol 매핑 (첫 번째 항목만)
  if (!DOMESTIC_MASTER_BY_NAME.has(entry.stockName)) {
    DOMESTIC_MASTER_BY_NAME.set(entry.stockName, entry);
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
 * - 국내: 종목코드(symbol), 종목명(stockName)
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
    if (results.length >= limit) break;

    const displayCode = `KRX:${entry.symbol}`;
    if (seenDisplayCodes.has(displayCode)) continue;

    const matches =
      entry.symbol.includes(query) ||
      entry.symbol.includes(upperQuery) ||
      entry.stockName.includes(query) ||
      displayCode.toUpperCase().includes(upperQuery) ||
      entry.exchangeCode.toUpperCase().includes(upperQuery);

    if (matches) {
      seenDisplayCodes.add(displayCode);
      results.push({
        market: 'DOMESTIC',
        exchangeCode: 'KRX',
        symbol: entry.symbol,
        displayCode,
        stockName: entry.stockName,
        koreanName: entry.stockName,
        currency: 'KRW',
        source: 'DOMESTIC_MASTER',
      });
    }
  }

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
