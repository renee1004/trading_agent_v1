// Ported from renee1004/Trading_Agent/lib/kis/overseasMaster.ts
// 해외 종목 마스터 기반 EXCD 자동 매핑 유틸
// 목적: 해외 종목 현재가 조회 시 NVDA 같은 순수 심볼도 KIS EXCD(NAS/NYS/AMS)로 안정 매핑
//
// 데이터 소스 우선순위:
// 1. data/overseas-symbols.json (전체 KIS 해외 종목 마스터)
// 2. OVERSEAS_MASTER_ITEMS 하드코딩 fallback (대표 종목)

import overseasSymbolsData from '../../data/overseas-symbols.json';

export type OverseasExchangeCode = 'NAS' | 'NYS' | 'AMS';

export type OverseasMasterItem = {
  symbol: string;
  name?: string;
  exchange: OverseasExchangeCode;
  aliases?: string[];
  assetType?: 'STOCK' | 'ETF' | 'ETN' | 'ADR' | 'OTHER';
  /** 한글 종목명 (JSON 마스터에서 로드) */
  koreanName?: string;
  /** 영문 종목명 (JSON 마스터에서 로드) */
  englishName?: string;
};

export const OVERSEAS_EXCHANGE_SUFFIX_MAP: Record<string, OverseasExchangeCode> = {
  NAS: 'NAS',
  NASD: 'NAS',
  NASDAQ: 'NAS',
  XNAS: 'NAS',
  NYS: 'NYS',
  NYSE: 'NYS',
  XNYS: 'NYS',
  AMS: 'AMS',
  AMEX: 'AMS',
  ARCA: 'AMS',
  NYSEARCA: 'AMS',
  ARCX: 'AMS',
};

// 하드코딩 fallback: 대표 종목만 (JSON 파일이 없을 때 사용)
const OVERSEAS_MASTER_ITEMS: OverseasMasterItem[] = [
  // Nasdaq large caps
  { symbol: 'AAPL', name: 'Apple', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'MSFT', name: 'Microsoft', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'NVDA', name: 'NVIDIA', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'TSLA', name: 'Tesla', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'GOOGL', name: 'Alphabet Class A', exchange: 'NAS', aliases: ['GOOG'], assetType: 'STOCK' },
  { symbol: 'GOOG', name: 'Alphabet Class C', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'AMZN', name: 'Amazon', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'META', name: 'Meta Platforms', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'AMD', name: 'AMD', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'AVGO', name: 'Broadcom', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'PLTR', name: 'Palantir', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'MSTR', name: 'MicroStrategy', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'NFLX', name: 'Netflix', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'COST', name: 'Costco', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'ADBE', name: 'Adobe', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'INTC', name: 'Intel', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'CSCO', name: 'Cisco', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'PEP', name: 'PepsiCo', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'QCOM', name: 'Qualcomm', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'TXN', name: 'Texas Instruments', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'AMAT', name: 'Applied Materials', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'MU', name: 'Micron', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'MRVL', name: 'Marvell', exchange: 'NAS', assetType: 'STOCK' },
  { symbol: 'SMCI', name: 'Super Micro Computer', exchange: 'NAS', assetType: 'STOCK' },

  // Nasdaq ETFs
  { symbol: 'QQQ', name: 'Invesco QQQ', exchange: 'NAS', assetType: 'ETF' },
  { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', exchange: 'NAS', assetType: 'ETF' },
  { symbol: 'SQQQ', name: 'ProShares UltraPro Short QQQ', exchange: 'NAS', assetType: 'ETF' },
  { symbol: 'SOXX', name: 'iShares Semiconductor ETF', exchange: 'NAS', assetType: 'ETF' },
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', exchange: 'NAS', assetType: 'ETF' },
  { symbol: 'IBB', name: 'iShares Biotechnology ETF', exchange: 'NAS', assetType: 'ETF' },

  // NYSE large caps
  { symbol: 'JPM', name: 'JPMorgan Chase', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'BAC', name: 'Bank of America', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'WMT', name: 'Walmart', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'DIS', name: 'Disney', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'KO', name: 'Coca-Cola', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'PFE', name: 'Pfizer', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'XOM', name: 'Exxon Mobil', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'CVX', name: 'Chevron', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'V', name: 'Visa', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'MA', name: 'Mastercard', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'IBM', name: 'IBM', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'ORCL', name: 'Oracle', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'CRM', name: 'Salesforce', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'NKE', name: 'Nike', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'MCD', name: "McDonald's", exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'HD', name: 'Home Depot', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'UNH', name: 'UnitedHealth', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'LLY', name: 'Eli Lilly', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'NVO', name: 'Novo Nordisk ADR', exchange: 'NYS', assetType: 'ADR' },
  { symbol: 'TSM', name: 'TSMC ADR', exchange: 'NYS', assetType: 'ADR' },
  { symbol: 'BABA', name: 'Alibaba ADR', exchange: 'NYS', assetType: 'ADR' },
  { symbol: 'SHOP', name: 'Shopify', exchange: 'NYS', assetType: 'STOCK' },
  { symbol: 'UBER', name: 'Uber', exchange: 'NYS', assetType: 'STOCK' },

  // AMEX / ARCA ETFs and leveraged products
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'IVV', name: 'iShares Core S&P 500 ETF', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'GLD', name: 'SPDR Gold Shares', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'SLV', name: 'iShares Silver Trust', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'SOXL', name: 'Direxion Daily Semiconductor Bull 3X', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'SOXS', name: 'Direxion Daily Semiconductor Bear 3X', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'ARKK', name: 'ARK Innovation ETF', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'XLF', name: 'Financial Select Sector SPDR Fund', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'XLE', name: 'Energy Select Sector SPDR Fund', exchange: 'AMS', assetType: 'ETF' },
  { symbol: 'XLK', name: 'Technology Select Sector SPDR Fund', exchange: 'AMS', assetType: 'ETF' },
];

// ─── JSON 기반 전체 마스터 인덱스 구축 ───
// overseas-symbols.json에서 로드한 전체 종목 데이터
type OverseasSymbolEntry = {
  symbol: string;
  excd: string;
  koreanName: string;
  englishName: string;
  marketName: string;
  exchangeName: string;
  securityType: string;
  currency: string;
};

/**
 * JSON 데이터 → OverseasMasterItem 변환
 * JSON의 excd가 OverseasExchangeCode 타입에 맞지 않으면 필터링
 */
function buildJsonMasterItems(data: OverseasSymbolEntry[]): OverseasMasterItem[] {
  const validExcd: Set<string> = new Set(['NAS', 'NYS', 'AMS']);
  return data
    .filter(entry => validExcd.has(entry.excd))
    .map(entry => ({
      symbol: entry.symbol.toUpperCase(),
      name: entry.englishName || entry.koreanName,
      exchange: entry.excd as OverseasExchangeCode,
      assetType: (entry.securityType === 'ETF' ? 'ETF' :
                   entry.securityType === 'ETN' ? 'ETN' :
                   entry.securityType === 'ADR' ? 'ADR' : 'STOCK') as OverseasMasterItem['assetType'],
      koreanName: entry.koreanName,
      englishName: entry.englishName,
    }));
}

const JSON_MASTER_ITEMS: OverseasMasterItem[] = buildJsonMasterItems(
  overseasSymbolsData as OverseasSymbolEntry[],
);

function normalizeMasterKey(value: string): string {
  return value.trim().toUpperCase().replace(/[.\s-]/g, '_');
}

export function normalizeOverseasMasterSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.US$/, '');
}

export function getExplicitOverseasExchangeCode(symbol: string): OverseasExchangeCode | undefined {
  const raw = normalizeOverseasMasterSymbol(symbol);
  const colonParts = raw.split(':');

  if (colonParts.length === 2) {
    return OVERSEAS_EXCHANGE_SUFFIX_MAP[colonParts[0]];
  }

  const dotParts = raw.split('.');
  const lastPart = dotParts[dotParts.length - 1];
  return OVERSEAS_EXCHANGE_SUFFIX_MAP[lastPart];
}

export function stripOverseasExchangeSuffix(symbol: string): string {
  const raw = normalizeOverseasMasterSymbol(symbol);
  const colonParts = raw.split(':');

  if (colonParts.length === 2 && OVERSEAS_EXCHANGE_SUFFIX_MAP[colonParts[0]]) {
    return colonParts[1];
  }

  const dotParts = raw.split('.');
  const lastPart = dotParts[dotParts.length - 1];

  if (OVERSEAS_EXCHANGE_SUFFIX_MAP[lastPart]) {
    return dotParts.slice(0, -1).join('.');
  }

  return raw;
}

/**
 * 마스터 인덱스 구축: JSON 전체 마스터 → 하드코딩 fallback 순서
 * JSON에 있는 종목이 우선, 없는 종목은 하드코딩 리스트에서 보완
 */
function buildMasterIndex(): Record<string, OverseasMasterItem> {
  const index: Record<string, OverseasMasterItem> = {};

  // 1. 하드코딩 fallback 먼저 로드 (나중에 JSON이 덮어씀)
  for (const item of OVERSEAS_MASTER_ITEMS) {
    const key = normalizeMasterKey(item.symbol);
    if (!index[key]) {
      index[key] = item;
    }
    item.aliases?.forEach((alias) => {
      const aliasKey = normalizeMasterKey(alias);
      if (!index[aliasKey]) {
        index[aliasKey] = item;
      }
    });
  }

  // 2. JSON 전체 마스터로 덮어쓰기 (우선순위 높음)
  for (const item of JSON_MASTER_ITEMS) {
    const key = normalizeMasterKey(item.symbol);
    index[key] = item; // JSON 데이터가 우선
  }

  return index;
}

const OVERSEAS_MASTER_INDEX = buildMasterIndex();

export function findOverseasMasterItem(symbol: string): OverseasMasterItem | undefined {
  const normalizedSymbol = stripOverseasExchangeSuffix(symbol);
  return OVERSEAS_MASTER_INDEX[normalizeMasterKey(normalizedSymbol)];
}

export function getOverseasMasterExchangeCode(symbol: string): OverseasExchangeCode | undefined {
  return findOverseasMasterItem(symbol)?.exchange;
}

export function normalizeOverseasDisplayCode(
  stockCode: string,
  fallbackExchange: OverseasExchangeCode = 'NAS',
): { exchangeCode: OverseasExchangeCode; symbol: string; displayCode: string; name?: string } {
  const explicitExchange = getExplicitOverseasExchangeCode(stockCode);
  const pureSymbol = stripOverseasExchangeSuffix(stockCode);
  const master = findOverseasMasterItem(pureSymbol);
  const exchangeCode = explicitExchange || master?.exchange || fallbackExchange;

  return {
    exchangeCode,
    symbol: pureSymbol,
    displayCode: `${exchangeCode}:${pureSymbol}`,
    name: master?.koreanName || master?.englishName || master?.name,
  };
}

/** 전체 마스터 종목 수 (JSON + 하드코딩 합계, 중복 제거 후) */
export function getOverseasMasterSize() {
  return Object.keys(OVERSEAS_MASTER_INDEX).length;
}

/** JSON 마스터 종목 수 */
export function getJsonMasterSize() {
  return JSON_MASTER_ITEMS.length;
}

/** 하드코딩 fallback 종목 수 */
export function getFallbackMasterSize() {
  return OVERSEAS_MASTER_ITEMS.length;
}

/**
 * 키워드로 해외 종목 검색 (로컬 마스터만 사용, KIS API 호출 없음)
 * symbol, englishName, koreanName 대상 부분 일치 검색
 */
export function searchOverseasMaster(
  query: string,
  limit: number = 30,
): OverseasMasterItem[] {
  if (!query || query.length < 1) return [];

  const upperQuery = query.toUpperCase();
  const lowerQuery = query.toLowerCase();
  const results: OverseasMasterItem[] = [];
  const seen = new Set<string>();

  for (const item of Object.values(OVERSEAS_MASTER_INDEX)) {
    if (results.length >= limit) break;
    if (seen.has(item.symbol)) continue;

    const matches =
      item.symbol.toUpperCase().includes(upperQuery) ||
      (item.koreanName && item.koreanName.includes(query)) ||
      (item.englishName && item.englishName.toLowerCase().includes(lowerQuery)) ||
      (item.name && item.name.toLowerCase().includes(lowerQuery));

    if (matches) {
      seen.add(item.symbol);
      results.push(item);
    }
  }

  return results;
}
