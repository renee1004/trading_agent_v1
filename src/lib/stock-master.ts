import {
  findOverseasMasterItem,
  normalizeOverseasDisplayCode,
  type OverseasExchangeCode,
} from './kis-overseas-master';

export type DashboardMarket = 'DOMESTIC' | 'OVERSEAS' | 'UNKNOWN';

export type StockMasterItem = {
  market: DashboardMarket;
  exchangeCode: string;
  symbol: string;
  displayCode: string;
  stockName: string;
  currency: 'KRW' | 'USD';
  source: 'DOMESTIC_CODE' | 'OVERSEAS_MASTER' | 'OVERSEAS_FALLBACK' | 'UNKNOWN';
};

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isDomesticStockCode(code: string): boolean {
  const normalized = normalizeCode(code).replace(/^KRX:/, '').replace(/\.(KS|KQ)$/, '');
  return /^\d{6}$/.test(normalized);
}

export function normalizeDomesticStockCode(code: string): StockMasterItem {
  const symbol = normalizeCode(code).replace(/^KRX:/, '').replace(/\.(KS|KQ)$/, '');

  return {
    market: 'DOMESTIC',
    exchangeCode: 'KRX',
    symbol,
    displayCode: `KRX:${symbol}`,
    stockName: symbol,
    currency: 'KRW',
    source: 'DOMESTIC_CODE',
  };
}

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
    stockName: normalized.name || master?.name || normalized.symbol,
    currency: 'USD',
    source: master ? 'OVERSEAS_MASTER' : 'OVERSEAS_FALLBACK',
  };
}

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
