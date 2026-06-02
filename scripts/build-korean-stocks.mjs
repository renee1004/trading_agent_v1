#!/usr/bin/env node
/**
 * 한국투자증권(KIS) 종목 마스터 .mst 파일 → korean-stocks.json 변환 스크립트
 *
 * 입력: upload/ 디렉토리의 KIS 마스터 파일
 *   - kospi_code.mst  (KOSPI 종목)
 *   - kosdaq_code.mst (KOSDAQ 종목)
 *   - nxt_kospi_code.mst (차세대 KOSPI)
 *   - nxt_kosdaq_code.mst (차세대 KOSDAQ)
 *   - theme_code.mst  (테마별 종목 그룹)
 *
 * 출력: data/korean-stocks.json
 *
 * KIS 마스터 파일 포맷 (EUC-KR, 고정폭):
 *   - kospi/kosdaq_code.mst: 코드(9) + ISIN(12) + 종목명(가변) + 그룹코드(2) + ...
 *   - nxt_kospi/nxt_kosdaq_code.mst: 유사 포맷 (약간 다른 레이아웃)
 *   - theme_code.mst: 테마코드 + 테마명 + 종목코드(6)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ─── EUC-KR 디코딩 (iconv-lite 없이 Node.js 내장 TextDecoder 사용) ───
// Node.js 22+ 에서 EUC-KR 지원. 미지원시 수동 폴백.
function decodeEucKr(buffer) {
  try {
    const decoder = new TextDecoder('euc-kr');
    return decoder.decode(buffer);
  } catch {
    // EUC-KR 미지원 환경 폴백: 각 바이트를 개별적으로 처리
    // ASCII 범위는 그대로, 한글(2바이트)은 유니코드로 변환
    const result = [];
    let i = 0;
    while (i < buffer.length) {
      const byte = buffer[i];
      if (byte <= 0x7F) {
        result.push(String.fromCharCode(byte));
        i++;
      } else {
        // 2바이트 EUC-KR → 유니코드 변환 시도
        const byte2 = buffer[i + 1];
        if (byte2 !== undefined) {
          result.push(String.fromCharCode((byte << 8) | byte2));
          i += 2;
        } else {
          result.push('?');
          i++;
        }
      }
    }
    return result.join('');
  }
}

/**
 * KIS kospi/kosdaq 마스터 파일 파싱
 *
 * 라인 포맷 (kospi_code.mst / kosdaq_code.mst):
 *   필드          오프셋   길이   설명
 *   표준코드       0        9     "000070   " 또는 "F70100026"
 *   ISIN          9        12    "KR7000070003"
 *   종목명         21       가변  공백으로 끝남, 다음 필드 전까지
 *   그룹코드       다음2    2     "ST"(주식), "EF"(ETF), "BC"(수익증권), "FS"(해외)
 *   ...
 *
 * nxt_kospi/nxt_kosdaq은 약간 다른 레이아웃이지만 기본 구조 동일
 */
function parseMasterFile(filePath, market, sourceName) {
  if (!existsSync(filePath)) {
    console.warn(`⚠️  파일 없음: ${filePath}`);
    return [];
  }

  const buffer = readFileSync(filePath);
  const content = decodeEucKr(buffer);
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);

  const stocks = [];

  for (const line of lines) {
    try {
      const stock = parseMasterLine(line, market, sourceName);
      if (stock) {
        stocks.push(stock);
      }
    } catch (err) {
      // 파싱 실패한 라인은 스킵
    }
  }

  return stocks;
}

/**
 * 마스터 파일 한 라인 파싱
 * 
 * KIS 마스터 포맷 (고정폭):
 *   [0-8]   표준코드 (9바이트, 우측 공백 패딩)
 *   [9-20]  ISIN 코드 (12바이트, "KR7" 접두사)
 *   [21-]   종목명 (가변, 공백으로 구분)
 *   
 *   종목명 이후: 그룹코드(ST/EF/BC/FS) + 기타 필드
 */
function parseMasterLine(line, market, sourceName) {
  if (line.length < 24) return null;

  // 표준코드 추출 (9바이트, 공백 제거)
  const rawCode = line.substring(0, 9).trim();
  if (!rawCode) return null;

  // ISIN 코드 추출 (위치 9부터 12바이트)
  const isinRaw = line.substring(9, 21).trim();

  // 종목명 추출: ISIN 이후부터 그룹코드(ST/EF/BC/FS) 전까지
  // 종목명은 21번째 위치에서 시작, 다음 공백+그룹코드 패턴 전까지
  const rest = line.substring(21);
  
  // 그룹코드 패턴 찾기: " ST", " EF", " BC", " FS" (공백+2글자 그룹코드)
  let name = '';
  let groupCode = '';
  const groupPattern = /\s+(ST|EF|BC|FS)\s/;
  const groupMatch = rest.match(groupPattern);
  
  if (groupMatch) {
    name = rest.substring(0, groupMatch.index).trim();
    groupCode = groupMatch[1];
  } else {
    // 그룹코드를 찾지 못한 경우, 종목명만 추출 시도
    // 다중 공백으로 구분되는 경우도 있음
    const parts = rest.split(/\s{2,}/);
    name = parts[0]?.trim() || '';
    if (parts.length > 1) {
      groupCode = parts[1]?.substring(0, 2)?.trim() || '';
    }
  }

  if (!name) return null;

  // ISIN에서 "KR" 접두사가 있으면 standardCode로 사용
  const standardCode = isinRaw.startsWith('KR') ? isinRaw : undefined;

  // 종목 유형 판별 (이전 korean-stocks.json과 호환: BC/FS도 EQUITY로 처리)
  let type = 'EQUITY';
  if (groupCode === 'EF') type = 'ETF';
  // BC(수익증권), FS(해외)도 검색 가능하도록 EQUITY로 분류
  // 이전 JSON에서는 모두 EQUITY로 처리되었음

  // symbol 생성: .KS(KOSPI) 또는 .KQ(KOSDAQ)
  const suffix = market === 'KOSPI' ? 'KS' : market === 'KOSDAQ' ? 'KQ' : 'KS';

  return {
    code: rawCode,
    symbol: `${rawCode}.${suffix}`,
    standardCode,
    name,
    market,
    venue: 'MAIN',
    type,
    source: sourceName,
  };
}

/**
 * 테마 마스터 파일 파싱
 * 
 * theme_code.mst 포맷:
 *   테마코드(8) + 공백 + 테마명(가변) + 공백 + 종목코드(6)
 *   예: "0272018 신규 상장주                        027360"
 */
function parseThemeFile(filePath) {
  if (!existsSync(filePath)) {
    console.warn(`⚠️  파일 없음: ${filePath}`);
    return { themes: [], themeStocks: [] };
  }

  const buffer = readFileSync(filePath);
  const content = decodeEucKr(buffer);
  const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);

  const themes = new Map(); // themeCode → themeName
  const themeStocks = []; // { themeCode, themeName, stockCode }

  for (const line of lines) {
    if (line.length < 14) continue;

    try {
      // 테마코드: 첫 8바이트 (숫자+공백 패턴)
      const themeCodeRaw = line.substring(0, 8).trim();
      if (!themeCodeRaw || !/^\d+$/.test(themeCodeRaw)) continue;

      // 나머지에서 테마명과 종목코드 분리
      // 종목코드는 마지막 6자리 숫자 (앞에 공백)
      const rest = line.substring(8);
      
      // 마지막 6자리+앞공백 패턴으로 종목코드 찾기
      const stockCodeMatch = rest.match(/\s+(\d{6})\s*$/);
      let stockCode = '';
      let themeNamePart = rest;

      if (stockCodeMatch) {
        stockCode = stockCodeMatch[1];
        themeNamePart = rest.substring(0, rest.length - stockCodeMatch[0].length);
      }

      const themeName = themeNamePart.trim();
      if (!themeName || !stockCode) continue;

      // 테마 정보 저장
      if (!themes.has(themeCodeRaw)) {
        themes.set(themeCodeRaw, themeName);
      }

      themeStocks.push({
        themeCode: themeCodeRaw,
        themeName,
        stockCode,
      });
    } catch (err) {
      // 파싱 실패 스킵
    }
  }

  return { themes, themeStocks };
}

// ─── 메인 실행 ───
function main() {
  console.log('🔄 한국투자증권 국내 종목 마스터 변환 시작...\n');

  const uploadDir = resolve(PROJECT_ROOT, 'upload');
  const dataDir = resolve(PROJECT_ROOT, 'data');

  // 1. KOSPI 마스터 파싱
  const kospiStocks = parseMasterFile(
    resolve(uploadDir, 'kospi_code.mst'),
    'KOSPI',
    'kospi_code.mst'
  );
  console.log(`✅ KOSPI: ${kospiStocks.length}개 종목`);

  // 2. KOSDAQ 마스터 파싱
  const kosdaqStocks = parseMasterFile(
    resolve(uploadDir, 'kosdaq_code.mst'),
    'KOSDAQ',
    'kosdaq_code.mst'
  );
  console.log(`✅ KOSDAQ: ${kosdaqStocks.length}개 종목`);

  // 3. 차세대 KOSPI 마스터 파싱 (NXT)
  const nxtKospiStocks = parseMasterFile(
    resolve(uploadDir, 'nxt_kospi_code.mst'),
    'KOSPI',
    'nxt_kospi_code.mst'
  );
  console.log(`✅ NXT KOSPI: ${nxtKospiStocks.length}개 종목`);

  // 4. 차세대 KOSDAQ 마스터 파싱 (NXT)
  const nxtKosdaqStocks = parseMasterFile(
    resolve(uploadDir, 'nxt_kosdaq_code.mst'),
    'KOSDAQ',
    'nxt_kosdaq_code.mst'
  );
  console.log(`✅ NXT KOSDAQ: ${nxtKosdaqStocks.length}개 종목`);

  // 5. 테마 마스터 파싱
  const { themes, themeStocks } = parseThemeFile(
    resolve(uploadDir, 'theme_code.mst')
  );
  console.log(`✅ 테마: ${themes.size}개 그룹, ${themeStocks.length}개 종목-테마 매핑`);

  // ─── 중복 제거 및 병합 ───
  // 우선순위: kospi > kosdaq > nxt_kospi > nxt_kosdaq (기존 순서 유지)
  // 코드+마켓 조합으로 중복 제거 (같은 코드가 KOSPI/KOSDAQ에 있을 수 있음)
  const seen = new Set();
  const allStocks = [];

  for (const stock of [...kospiStocks, ...kosdaqStocks, ...nxtKospiStocks, ...nxtKosdaqStocks]) {
    // code 기준으로 중복 제거 (같은 코드면 첫 번째 것 유지)
    if (!seen.has(stock.code)) {
      seen.add(stock.code);
      allStocks.push(stock);
    }
  }

  // NXT 파일에서 기존에 없던 새 종목 추가 확인
  const preNxtCount = kospiStocks.length + kosdaqStocks.length;
  const nxtOnlyCount = allStocks.length - preNxtCount;
  if (nxtOnlyCount > 0) {
    console.log(`   NXT에서 추가된 신규 종목: ${nxtOnlyCount}개`);
  }

  console.log(`\n📊 총 종목 수: ${allStocks.length}개 (중복 제거 후)`);

  // 종목 유형별 통계
  const typeStats = {};
  for (const s of allStocks) {
    typeStats[s.type] = (typeStats[s.type] || 0) + 1;
  }
  console.log('   유형별:', typeStats);

  // 마켓별 통계
  const marketStats = {};
  for (const s of allStocks) {
    marketStats[s.market] = (marketStats[s.market] || 0) + 1;
  }
  console.log('   마켓별:', marketStats);

  // ─── korean-stocks.json 저장 ───
  const outputPath = resolve(dataDir, 'korean-stocks.json');
  writeFileSync(outputPath, JSON.stringify(allStocks, null, 2), 'utf-8');
  console.log(`\n💾 저장 완료: ${outputPath}`);

  // ─── 테마 데이터 저장 ───
  if (themeStocks.length > 0) {
    const themeData = {
      generatedAt: new Date().toISOString(),
      themeCount: themes.size,
      mappingCount: themeStocks.length,
      themes: Object.fromEntries(themes),
      mappings: themeStocks,
    };

    const themeOutputPath = resolve(dataDir, 'korean-themes.json');
    writeFileSync(themeOutputPath, JSON.stringify(themeData, null, 2), 'utf-8');
    console.log(`💾 테마 데이터 저장: ${themeOutputPath}`);
  }

  console.log('\n🎉 변환 완료!');
}

main();
