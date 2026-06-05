// 종목 마스터 통합 정규화 모듈
// 국내/해외 전체 KIS 종목 마스터 기반 정규화 + 검색
//
// 데이터 소스:
// 해외: data/overseas-symbols.json (12,161종목 - KIS COD 파일에서 생성)
// 국내: data/korean-stocks.json (4,346종목 - KIS 마스터 파일에서 생성)
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

/**
 * 국내 종목코드 추출
 *
 * KRX 종목코드 포맷:
 * - 일반주식: 순수 6자리 숫자 ("005930" = 삼성전자)
 * - ETF/ETN: 6자리 영숫자 ("0000D0" = TIGER 엔비디아미국채커버드콜)
 * - 우선주: 6자리 숫자+K/L 접미사 ("00088K" = 한화3우B)
 * - 신주인수권증서: J 접두사 ("J0036221D")
 * - 특수상품(F-code): F 접두사 ("F70100026")
 *
 * KIS 국내주식 API (FHKST01010100)는 6자리 영숫자 코드를 지원하므로
 * 일반주식과 ETF/ETN 모두 검색 가능하도록 인덱스에 포함
 * 우선주(K/L), J-code, F-code는 KIS API 호환성이 불확실하므로
 * 별도 인덱스로 분리하여 검색에서는 노출하되 API 호출 시 주의 필요
 */

/**
 * 일반 국내 종목코드 추출 (6자리 숫자 또는 6자리 영숫자)
 * KIS API 호환: 일반주식 + ETF/ETN
 */
function extractDomesticCode(code: string): string | null {
  // 6자리 숫자 (일반주식): "005930"
  const pureNumeric = code.match(/^(\d{6})$/);
  if (pureNumeric) return pureNumeric[1];

  // 6자리 영숫자 (ETF/ETN): "0000D0", "0000H0", "0005A0"
  // 패턴: 숫자 4자리 + 영숫자 2자리
  const alphaNumeric = code.match(/^(\d{4}[A-Z0-9]{2})$/);
  if (alphaNumeric) return alphaNumeric[1];

  // ETN 코드: "Q500061", "Q520066" 등
  // 패턴: Q + 영숫자 6자리 이상
  const etnCode = code.match(/^(Q[A-Z0-9]{4,})$/);
  if (etnCode) return etnCode[1];

  return null;
}

/**
 * 특수 국내 종목코드 추출 (우선주 K/L 접미사)
 * 예: "00088K" → { base: "000880", suffix: "K" }
 * KIS API에서는 보통주(6자리 숫자) 코드로 조회 가능
 */
function extractPreferredStockCode(code: string): { base: string; suffix: string; displayCode: string } | null {
  const match = code.match(/^(\d{5})([KL])$/);
  if (!match) return null;
  return {
    base: match[1] + '0', // 보통주 코드 (5자리 + '0')
    suffix: match[2],
    displayCode: code, // 우선주 고유 코드 유지
  };
}

/** 검색/정규화에 사용할 국내 종목 인덱스 */
interface DomesticIndexEntry {
  symbol: string;       // 종목코드 "005930" 또는 "0000D0"
  displayCode: string;  // "KRX:005930" 또는 "KRX:0000D0"
  stockName: string;    // "삼성전자"
  market: string;       // "KOSPI" | "KOSDAQ" | "KONEX"
  exchangeCode: string; // "KRX"
  currency: string;     // "KRW"
  codeType: 'STANDARD' | 'ETF_ALPHANUMERIC' | 'ETN' | 'PREFERRED' | 'SPECIAL';
  /** 우선주인 경우 보통주 symbol (API 조회용) */
  baseSymbol?: string;
}

const DOMESTIC_MASTER_ITEMS: DomesticIndexEntry[] = [];
const DOMESTIC_MASTER_BY_SYMBOL = new Map<string, DomesticIndexEntry>();
const DOMESTIC_MASTER_BY_NAME = new Map<string, DomesticIndexEntry>();

for (const entry of KOREAN_STOCK_ITEMS) {
  let indexEntry: DomesticIndexEntry | null = null;

  // 1) 일반 종목코드 (6자리 숫자) — 보통주, 일반 ETF
  const domesticCode = extractDomesticCode(entry.code);
  if (domesticCode) {
    const displayCode = `KRX:${domesticCode}`;
    // 동일 코드가 이미 있으면 건너뜀 (첫 번째 항목 우선 - 보통 보통주)
    if (DOMESTIC_MASTER_BY_SYMBOL.has(domesticCode)) continue;

    const isAlphanumeric = /[A-Z]/.test(domesticCode);
    indexEntry = {
      symbol: domesticCode,
      displayCode,
      stockName: entry.name,
      market: entry.market,
      exchangeCode: 'KRX',
      currency: 'KRW',
      codeType: isAlphanumeric ? 'ETF_ALPHANUMERIC' : 'STANDARD',
    };
  }

  // 2) 우선주 (5자리 숫자 + K/L 접미사)
  if (!indexEntry) {
    const preferredCode = extractPreferredStockCode(entry.code);
    if (preferredCode) {
      const displayCode = `KRX:${preferredCode.displayCode}`;
      if (DOMESTIC_MASTER_BY_SYMBOL.has(preferredCode.displayCode)) continue;

      indexEntry = {
        symbol: preferredCode.displayCode,
        displayCode,
        stockName: entry.name,
        market: entry.market,
        exchangeCode: 'KRX',
        currency: 'KRW',
        codeType: 'PREFERRED',
        baseSymbol: preferredCode.base,
      };
    }
  }

  // 3) 특수 코드 (F-code, J-code 등) — 검색은 가능하나 API 호환성 제한
  if (!indexEntry && (entry.code.startsWith('F') || entry.code.startsWith('J'))) {
    const displayCode = `KRX:${entry.code}`;
    if (DOMESTIC_MASTER_BY_SYMBOL.has(entry.code)) continue;

    indexEntry = {
      symbol: entry.code,
      displayCode,
      stockName: entry.name,
      market: entry.market,
      exchangeCode: 'KRX',
      currency: 'KRW',
      codeType: 'SPECIAL',
    };
  }

  // 4) ETN 코드 (Q-code) — Q5xxxxx 패턴, KIS API에서 지원
  // 예: Q500061 (신한 인버스 코스피 200 선물 ETN)
  if (!indexEntry && entry.code.startsWith('Q') && /^Q[A-Z0-9]{4,}$/.test(entry.code)) {
    const displayCode = `KRX:${entry.code}`;
    if (DOMESTIC_MASTER_BY_SYMBOL.has(entry.code)) continue;

    indexEntry = {
      symbol: entry.code,
      displayCode,
      stockName: entry.name,
      market: entry.market,
      exchangeCode: 'KRX',
      currency: 'KRW',
      codeType: 'ETN',
    };
  }

  if (!indexEntry) continue;

  DOMESTIC_MASTER_ITEMS.push(indexEntry);
  DOMESTIC_MASTER_BY_SYMBOL.set(indexEntry.symbol, indexEntry);
  if (!DOMESTIC_MASTER_BY_NAME.has(entry.name)) {
    DOMESTIC_MASTER_BY_NAME.set(entry.name, indexEntry);
  }
}

function normalizeCode(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * 국내 종목코드 판별
 * 지원 포맷:
 * - 순수 6자리 숫자: "005930" (보통주)
 * - 6자리 영숫자: "0000D0" (ETF/ETN)
 * - Q 접두사 + 영숫자: "Q500061" (ETN)
 * - 5자리+K/L: "00088K" (우선주)
 * - F/J 접두사: "F70100026", "J0036221D" (특수상품)
 */
export function isDomesticStockCode(code: string): boolean {
  const normalized = normalizeCode(code).replace(/^KRX:/, '').replace(/\.(KS|KQ)$/, '');
  // 순수 6자리 숫자 (보통주)
  if (/^\d{6}$/.test(normalized)) return true;
  // 6자리 영숫자 (ETF/ETN): 숫자 4자리 + 영숫자 2자리
  if (/^\d{4}[A-Z0-9]{2}$/.test(normalized)) return true;
  // ETN: Q + 영숫자 4자리 이상
  if (/^Q[A-Z0-9]{4,}$/.test(normalized)) return true;
  // 우선주: 5자리 숫자 + K/L
  if (/^\d{5}[KL]$/.test(normalized)) return true;
  // 특수상품: F 또는 J 접두사
  if (/^[FJ]/.test(normalized)) return true;
  return false;
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
 * 국내 코드 (6자리 숫자, 6자리 영숫자, 우선주, F/J-code) → 국내
 * 그 외 → 해외
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
  /** 검색 관련도 점수 (낮을수록 상위) */
  _score?: number;
};

// ─── 한글 별명 매핑 (사용자가 자주 검색하는 한글명 → 실제 심볼) ───
const KOREAN_ALIAS_MAP: Record<string, string> = {
  '구글': 'GOOGL',
  '구글A': 'GOOGL',
  '구글C': 'GOOG',
  '애플': 'AAPL',
  '마이크로소프트': 'MSFT',
  '아마존': 'AMZN',
  '테슬라': 'TSLA',
  '엔비디아': 'NVDA',
  '메타': 'META',
  '페이스북': 'META',
  '넷플릭스': 'NFLX',
  '인텔': 'INTC',
  '비자': 'V',
  '마스터카드': 'MA',
  '버크셔': 'BRK/B',
  '버크셔햄서웨이': 'BRK/B',
  '스타벅스': 'SBUX',
  '나이키': 'NKE',
  '코카콜라': 'KO',
  '맥도날드': 'MCD',
  '디즈니': 'DIS',
  '홈디포': 'HD',
  '보잉': 'BA',
  '페이팔': 'PYPL',
  '세일즈포스': 'CRM',
  '코인베이스': 'COIN',
  '쇼피파이': 'SHOP',
  '우버': 'UBER',
  '에어비앤비': 'ABNB',
  '팔란티어': 'PLTR',
  '소파이': 'SOFI',
  '리비안': 'RIVN',
  '롤스로이스': 'RYCEY',
  'TSMC': 'TSM',
  '티에스엠씨': 'TSM',
  '알리바바': 'BABA',
  '바이두': 'BIDU',
  '닌텐도': 'NTDOY',
  '소니': 'SONY',
  '토요타': 'TM',
  '삼성전자ADR': 'SSNLF',
  // 심볼 변경 이력 매핑
  'SQ': 'XYZ',           // Block, Inc. (2025년 SQ → XYZ 변경)
  '스퀘어': 'XYZ',       // Block, Inc. 구명
  '블록': 'XYZ',         // Block, Inc. 현재명
};

/**
 * 검색 관련도 점수 계산 (낮을수록 상위 노출)
 *
 * 점수 체계:
 *   0  = symbol 정확 일치 (최우선)
 *   1  = 종목명 정확 일치
 *   2  = symbol 접두사 일치
 *   3  = 종목명 접두사 일치
 *   4  = 한글명 포함
 *   5  = 영문명 포함
 *   6  = 기타 포함
 */
function calcSearchScore(
  item: { symbol: string; stockName: string; koreanName?: string; englishName?: string },
  query: string,
  upperQuery: string,
): number {
  // 정규화된 심볼 비교 (BRK.B === BRK/B === BRKB)
  const normSymbol = item.symbol.toUpperCase().replace(/[.\/\s\-]/g, '');
  const normQuery = upperQuery.replace(/[.\/\s\-]/g, '');
  // 1. symbol 정확 일치 (원본 또는 정규화)
  if (item.symbol === upperQuery || item.symbol === query || normSymbol === normQuery) return 0;
  // 2. 종목명 정확 일치
  if (item.stockName === query || item.koreanName === query) return 1;
  // 3. symbol 접두사 일치 (원본 또는 정규화)
  if (item.symbol.startsWith(upperQuery) || item.symbol.startsWith(query) || normSymbol.startsWith(normQuery)) return 2;
  // 4. 종목명 접두사 일치 ("현대차"가 "현대차증권"보다 먼저)
  if (item.stockName.startsWith(query) || item.koreanName?.startsWith(query)) return 3;
  // 5. 한글명 포함
  if (item.stockName.includes(query) || item.koreanName?.includes(query)) return 4;
  // 6. 영문명 포함
  if (item.englishName?.toUpperCase().includes(upperQuery)) return 5;
  // 7. 기타 포함 (symbol contains 등)
  return 6;
}

/**
 * 국내+해외 통합 종목 검색 (로컬 마스터만 사용, KIS API 호출 없음)
 *
 * 개선 사항:
 * - 정확도 기반 정렬 (symbol 정확일치 → 종목명 정확일치 → 접두사 → 포함)
 * - 국내/해외 병렬 수집 후 통합 정렬 (limit 공유 문제 해결)
 * - 짧은 쿼리(1~2글자)에서 국내 과다 매칭 시 해외 결과 보장
 * - 한글 별명 매핑 ("구글" → GOOGL 등)
 */
export function searchAllStocks(
  query: string,
  limit: number = 30,
): StockSearchResult[] {
  if (!query || query.length < 1) return [];

  const upperQuery = query.toUpperCase();

  // ─── 별명 확장 (한글명 → 해외 심볼) ───
  const aliasQueries: string[] = [query];
  const aliasSymbol = KOREAN_ALIAS_MAP[query];
  if (aliasSymbol) {
    aliasQueries.push(aliasSymbol);
  }
  // BRK.B → BRK/B 매핑 (KIS에서 BRK/B를 사용)
  if (upperQuery === 'BRK.B' || upperQuery === 'BRKB') {
    if (!aliasQueries.some(q => q.toUpperCase() === 'BRK/B')) {
      aliasQueries.push('BRK/B');
    }
    if (!aliasQueries.some(q => q.toUpperCase() === 'BRK/A')) {
      aliasQueries.push('BRK/A');
    }
  }

  // ─── 국내 검색 ───
  const domesticResults: StockSearchResult[] = [];
  const domesticSeen = new Set<string>();

  for (const entry of DOMESTIC_MASTER_ITEMS) {
    if (domesticSeen.has(entry.displayCode)) continue;

    const matches =
      entry.symbol.includes(query) ||
      entry.symbol.includes(upperQuery) ||
      entry.stockName.includes(query) ||
      entry.displayCode.toUpperCase().includes(upperQuery);

    if (matches) {
      domesticSeen.add(entry.displayCode);
      const score = calcSearchScore(
        { symbol: entry.symbol, stockName: entry.stockName },
        query,
        upperQuery,
      );
      domesticResults.push({
        market: 'DOMESTIC',
        exchangeCode: 'KRX',
        symbol: entry.symbol,
        displayCode: entry.displayCode,
        stockName: entry.stockName,
        koreanName: entry.stockName,
        currency: 'KRW',
        source: 'DOMESTIC_MASTER',
        _score: score,
      });
    }
  }

  // 국내 결과를 점수순 정렬 후 상한 적용
  domesticResults.sort((a, b) => (a._score ?? 9) - (b._score ?? 9));

  // 짧은 쿼리(≤2글자)에서 국내 과다 매칭 방지: 상위 15개까지만
  const maxDomestic = query.length <= 2 ? 15 : 20;
  const trimmedDomestic = domesticResults.slice(0, maxDomestic);

  // ─── 해외 검색 ───
  const overseasResults: StockSearchResult[] = [];
  const overseasSeen = new Set<string>();

  // 별명 쿼리 포함하여 해외 검색
  for (const q of aliasQueries) {
    const upperQ = q.toUpperCase();
    const overseasItems = searchOverseasMaster(q, 50); // 여유 있게 검색
    for (const item of overseasItems) {
      const displayCode = `${item.exchange}:${item.symbol}`;
      if (overseasSeen.has(displayCode)) continue;

      overseasSeen.add(displayCode);
      const score = calcSearchScore(
        { symbol: item.symbol, stockName: item.koreanName || item.englishName || item.name || item.symbol, koreanName: item.koreanName, englishName: item.englishName || item.name },
        query,
        upperQuery,
      );
      // 별명 매핑으로 찾은 결과는 score 가산 (한글명 포함 결과보다 한 단계 우선)
      const adjustedScore = (q === aliasSymbol && score > 2) ? score - 3 : score;
      overseasResults.push({
        market: 'OVERSEAS',
        exchangeCode: item.exchange,
        symbol: item.symbol,
        displayCode,
        stockName: item.koreanName || item.englishName || item.name || item.symbol,
        koreanName: item.koreanName,
        englishName: item.englishName || item.name,
        currency: 'USD',
        source: 'KIS_OVERSEAS_MASTER',
        _score: adjustedScore,
      });
    }
  }

  // 해외 결과도 점수순 정렬
  overseasResults.sort((a, b) => (a._score ?? 9) - (b._score ?? 9));

  // ─── 통합 병합 ───
  // 해외 결과 최소 보장: 짧은 쿼리에서도 해외 결과가 최소 10개 나올 수 있도록
  const minOverseas = 10;
  const maxOverseas = Math.max(minOverseas, Math.floor(limit * 0.4));
  const trimmedOverseas = overseasResults.slice(0, maxOverseas);

  // 병합: 국내와 해외를 점수 기준으로 교차 배치
  const allResults: StockSearchResult[] = [];
  const seenDisplayCodes = new Set<string>();

  // 점수순으로 전체 정렬
  const merged = [...trimmedDomestic, ...trimmedOverseas]
    .sort((a, b) => (a._score ?? 9) - (b._score ?? 9));

  for (const item of merged) {
    if (seenDisplayCodes.has(item.displayCode)) continue;
    if (allResults.length >= limit) break;
    seenDisplayCodes.add(item.displayCode);
    allResults.push(item);
  }

  // ─── displayCode로도 검색 (예: "NAS:NVDA", "KRX:005930") ───
  if (upperQuery.includes(':')) {
    const [prefix, sym] = upperQuery.split(':');
    if (prefix && sym) {
      const normalized = normalizeDashboardStockCode(query);
      if (normalized.displayCode && !seenDisplayCodes.has(normalized.displayCode)) {
        seenDisplayCodes.add(normalized.displayCode);
        allResults.unshift({
          market: normalized.market,
          exchangeCode: normalized.exchangeCode,
          symbol: normalized.symbol,
          displayCode: normalized.displayCode,
          stockName: normalized.stockName,
          koreanName: normalized.koreanName,
          englishName: normalized.englishName,
          currency: normalized.currency as 'KRW' | 'USD',
          source: normalized.source as StockSearchResult['source'],
          _score: 0,
        });
      }
    }
  }

  return allResults;
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
 * 국내: 6자리 숫자, 6자리 영숫자(ETF), .KS, .KQ, KRX: 접두사
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
