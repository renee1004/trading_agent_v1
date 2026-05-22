// 자동 후보 종목 발굴 모듈
// 관심종목 + 보유종목 + 우량 대형주 풀을 결합하여 분석 대상 선정
// KIS 모의투자 API 제약으로 인해 거래대금 상위 직접 조회가 어려워
// 사전 정의된 우량주 풀 + 동적 관심종목 + 보유종목 방식 사용

import { db } from './db';
import { KisApiClient } from './kis-api';

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

export interface ScanResult {
  domestic: Array<{ code: string; name: string }>;
  overseas: Array<{ code: string; name: string; exchange: string }>;
  sources: {
    watchlist: number;
    positions: number;
    blueChips: number;
  };
}

/**
 * KIS API를 이용한 동적 종목 스캔
 * 보유종목 + 관심종목 + 우량주 풀을 병합하고 중복 제거
 */
export async function scanTargetStocks(
  kisClient: KisApiClient | null
): Promise<ScanResult> {
  const sources = { watchlist: 0, positions: 0, blueChips: 0 };
  const domesticSeen = new Set<string>();
  const overseasSeen = new Set<string>();
  const domestic: Array<{ code: string; name: string }> = [];
  const overseas: Array<{ code: string; name: string; exchange: string }> = [];

  // 1. 보유종목 (실제 포지션이 있으면 반드시 모니터링)
  if (kisClient) {
    try {
      const balance = await kisClient.getAccountBalance();
      for (const pos of balance.positions) {
        if (pos.quantity > 0 && !domesticSeen.has(pos.stockCode)) {
          domesticSeen.add(pos.stockCode);
          domestic.push({ code: pos.stockCode, name: pos.stockName });
          sources.positions++;
        }
      }
    } catch (e) {
      // 잔고 조회 실패 시 보유종목 스킵
    }

    try {
      const overseasBalance = await kisClient.getOverseasAccountBalance();
      for (const pos of overseasBalance.positions) {
        if (pos.quantity > 0 && !overseasSeen.has(pos.stockCode)) {
          overseasSeen.add(pos.stockCode);
          overseas.push({
            code: pos.stockCode,
            name: pos.stockName,
            exchange: pos.exchangeCode || 'NAS',
          });
          sources.positions++;
        }
      }
    } catch (e) {
      // 해외 잔고 조회 실패 시 스킵
    }
  }

  // 2. 관심종목 (사용자가 명시적으로 추가한 종목)
  try {
    const watchlist = await db.watchlistItem.findMany({
      where: { isActive: true },
    });

    for (const item of watchlist) {
      if (item.market === 'DOMESTIC' && !domesticSeen.has(item.stockCode)) {
        domesticSeen.add(item.stockCode);
        domestic.push({ code: item.stockCode, name: item.stockName });
        sources.watchlist++;
      } else if (item.market === 'OVERSEAS' && !overseasSeen.has(item.stockCode)) {
        overseasSeen.add(item.stockCode);
        overseas.push({
          code: item.stockCode,
          name: item.stockName,
          exchange: item.exchangeCode || 'NAS',
        });
        sources.watchlist++;
      }
    }
  } catch (e) {
    // DB 조회 실패 시 스킵
  }

  // 3. 우량 대형주 풀 (관심종목/보유종목에 없는 것만 추가)
  for (const stock of DOMESTIC_BLUE_CHIPS) {
    if (!domesticSeen.has(stock.code)) {
      domesticSeen.add(stock.code);
      domestic.push(stock);
      sources.blueChips++;
    }
  }

  for (const stock of OVERSEAS_BLUE_CHIPS) {
    if (!overseasSeen.has(stock.code)) {
      overseasSeen.add(stock.code);
      overseas.push(stock);
      sources.blueChips++;
    }
  }

  console.log(`[Market Scanner] 분석 대상: 국내 ${domestic.length}개, 해외 ${overseas.length}개`, sources);

  return { domestic, overseas, sources };
}
