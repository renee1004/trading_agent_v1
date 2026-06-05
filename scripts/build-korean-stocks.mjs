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
 * KIS 마스터 파일 포맷 (EUC-KR, 고정폭 바이트):
 *   오프셋   길이   필드명        설명
 *   0        9      표준코드      "005930   " 또는 "F70100026" (우측 공백 패딩)
 *   9        12     ISIN 코드     "KR7005930003"
 *   21       40     종목명        EUC-KR, 우측 공백 패딩
 *   61       2      그룹코드      "ST"(주식), "EF"(ETF), "BC"(수익증권), "FS"(해외)
 *   63       ...    기타 필드    (사용하지 않음)
 *
 * ※ 핵심: 그룹코드는 항상 BYTE offset 61에 위치 (고정폭)
 *   이전 버전에서는 decoded string에서 regex로 그룹코드를 찾았으나,
 *   EUC-KR의 2바이트 한글 때문에 decoded string 내 위치가 가변적이어서
 *   이름이 긴 ETF/ETN에서 그룹코드 분리 실패 → 쓰레기값 포함 문제 발생.
 *   → 바이트 레벨 파싱으로 정확히 분리.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ─── EUC-KR 디코딩 (Node.js 내장 TextDecoder 사용) ───
function decodeEucKr(buffer) {
  try {
    const decoder = new TextDecoder('euc-kr');
    return decoder.decode(buffer);
  } catch {
    // EUC-KR 미지원 환경 폴백: cp949 시도
    try {
      const decoder = new TextDecoder('cp949');
      return decoder.decode(buffer);
    } catch {
      // 최종 폴백: 각 바이트를 개별적으로 처리
      const result = [];
      let i = 0;
      while (i < buffer.length) {
        const byte = buffer[i];
        if (byte <= 0x7F) {
          result.push(String.fromCharCode(byte));
          i++;
        } else {
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
}

/**
 * KIS kospi/kosdaq 마스터 파일 파싱 (바이트 레벨)
 *
 * 라인 바이트 포맷:
 *   [0-8]    표준코드 (9 bytes, ASCII, 우측 공백 패딩)
 *   [9-20]   ISIN 코드 (12 bytes, ASCII)
 *   [21-60]  종목명   (40 bytes, EUC-KR, 우측 공백 패딩)
 *   [61-62]  그룹코드 (2 bytes, ASCII: ST/EF/BC/FS)
 *   [63-]    기타 필드
 */
function parseMasterFile(filePath, market, sourceName) {
  if (!existsSync(filePath)) {
    console.warn(`⚠️  파일 없음: ${filePath}`);
    return [];
  }

  const buffer = readFileSync(filePath);

  // 바이트 단위로 라인 분리 (CRLF/LF)
  const lines = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0A) { // LF
      // CR+LF인 경우 CR 제외
      const end = (i > 0 && buffer[i - 1] === 0x0D) ? i - 1 : i;
      if (end > start) {
        lines.push(buffer.subarray(start, end));
      }
      start = i + 1;
    }
  }
  // 마지막 라인
  if (start < buffer.length) {
    lines.push(buffer.subarray(start, buffer.length));
  }

  const stocks = [];

  for (const lineBytes of lines) {
    try {
      const stock = parseMasterLineBytes(lineBytes, market, sourceName);
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
 * 마스터 파일 한 라인 파싱 (바이트 레벨)
 *
 * 바이트 포맷 (고정폭):
 *   [0-8]    표준코드 (9 bytes)
 *   [9-20]   ISIN 코드 (12 bytes)
 *   [21-60]  종목명   (40 bytes, EUC-KR)
 *   [61-62]  그룹코드 (2 bytes: ST/EF/BC/FS)
 */
function parseMasterLineBytes(lineBytes, market, sourceName) {
  // 최소 63바이트 필요 (코드9 + ISIN12 + 이름40 + 그룹2)
  if (lineBytes.length < 63) return null;

  // 1) 표준코드 추출 (bytes 0-8, ASCII)
  const codeBytes = lineBytes.subarray(0, 9);
  const rawCode = new TextDecoder('ascii').decode(codeBytes).trim();
  if (!rawCode) return null;

  // 2) ISIN 코드 추출 (bytes 9-20, ASCII)
  const isinBytes = lineBytes.subarray(9, 21);
  const isinRaw = new TextDecoder('ascii').decode(isinBytes).trim();

  // 3) 종목명 추출 (bytes 21-60, EUC-KR, 우측 공백 트림)
  const nameBytes = lineBytes.subarray(21, 61);
  const name = decodeEucKr(nameBytes).trim();
  if (!name) return null;

  // 4) 그룹코드 추출 (bytes 61-62, ASCII)
  const groupBytes = lineBytes.subarray(61, 63);
  const groupCode = new TextDecoder('ascii').decode(groupBytes).trim();

  // ISIN에서 "KR" 접두사가 있으면 standardCode로 사용
  const standardCode = isinRaw.startsWith('KR') ? isinRaw : undefined;

  // 종목 유형 판별
  // ST = 주식, EF = ETF, BC = 수익증권, FS = 해외주식
  // ETN은 Q로 시작하는 코드 (Q5xxxxx) → 별도 분류
  let type = 'EQUITY';
  if (groupCode === 'EF') type = 'ETF';
  if (rawCode.startsWith('Q')) type = 'ETN';

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

  // ─── 이름 정상 여부 검증 ───
  let garbledCount = 0;
  const garbledSamples = [];
  for (const s of allStocks) {
    if (s.name.includes('0NN') || s.name.includes('NNN') || s.name.includes('00000')) {
      garbledCount++;
      if (garbledSamples.length < 5) garbledSamples.push(s);
    }
  }
  if (garbledCount > 0) {
    console.warn(`\n⚠️  이름에 쓰레기값 포함된 종목: ${garbledCount}개`);
    for (const s of garbledSamples) {
      console.warn(`   ${s.code} | ${s.name}`);
    }
  } else {
    console.log('\n✅ 모든 종목명 정상 (쓰레기값 없음)');
  }

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
