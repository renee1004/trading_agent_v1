// Ported from renee1004/Trading_Agent/lib/kis/overseasMaster.ts
// 해외 종목 마스터 기반 EXCD 자동 매핑 유틸
// 목적: 해외 종목 현재가 조회 시 NVDA 같은 순수 심볼도 KIS EXCD(NAS/NYS/AMS)로 안정 매핑

export type OverseasExchangeCode = 'NAS' | 'NYS' | 'AMS';

export type OverseasMasterItem = {
  symbol: string;
  name?: string;
  exchange: OverseasExchangeCode;
  aliases?: string[];
  assetType?: 'STOCK' | 'ETF' | 'ETN' | 'ADR' | 'OTHER';
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

function buildMasterIndex() {
  return OVERSEAS_MASTER_ITEMS.reduce<Record<string, OverseasMasterItem>>((acc, item) => {
    acc[normalizeMasterKey(item.symbol)] = item;

    item.aliases?.forEach((alias) => {
      acc[normalizeMasterKey(alias)] = item;
    });

    return acc;
  }, {});
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
    name: master?.name,
  };
}

export function getOverseasMasterSize() {
  return OVERSEAS_MASTER_ITEMS.length;
}
