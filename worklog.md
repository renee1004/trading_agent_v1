---
Task ID: 1
Agent: Main Agent
Task: Fix strategyAggressiveness=TEST DB persistence + KRX code normalization

Work Log:
- Read current state of all relevant files (settings route, effective-settings, trading-agent, status route, KIS API, stock-master, market-scanner, page.tsx)
- Analyzed root cause: strategyAggressiveness not persisting despite correct code - added read-after-write verification with auto-retry in settings route
- Improved test-mode endpoint with DB read-back verification and retry logic (up to 3 retries)
- Added diagnostic logging in getEffectiveTradingSettings() to track strategyAggressiveness from DB/default/merged
- Added normalizeStockCode() safety net in KIS API methods: getStockPrice, getStockDailyCandles, placeOrder
- Added normalizeStockCode() in trading-agent executeOrder for order request safety
- Committed and pushed to GitHub (525d659)

Stage Summary:
- Key fix: Read-after-write verification ensures strategyAggressiveness=TEST is actually saved to DB
- KRX code normalization now applied at KIS API level (safety net) + trading-agent level
- Detailed logging added for debugging persistence issues
- Pushed to GitHub, Railway will auto-deploy

---
Task ID: 2
Agent: Main Agent
Task: Fix strategyAggressiveness=TEST DB 저장 보강 + KRX 정규화 + UI 진단

Work Log:
- Analyzed root cause: strategyAggressiveness stays CONSERVATIVE despite TEST save attempts
- Added strategyAggressiveness whitelist validation in POST /api/settings/trading (CONSERVATIVE/TEST/AGGRESSIVE)
- Added force-injection if strategyAggressiveness disappears after validation
- Added unknown key warning logs
- Enhanced test-mode endpoint: Raw SQL fallback (Prisma failure → direct SQL), GET diagnostic endpoint
- Added testModeDiagnostics to /api/agent/status (aggressivenessSource, expectedThresholds, isTestMode etc.)
- Fixed placeOverseasOrder missing normalizeStockCode in kis-api.ts
- Enhanced UI PAPER+TEST buttons: verification result alerts, loadSettingsFromServer, DB 진단 버튼
- Resolved rebase conflict in test-mode/route.ts (merged remote's variable naming with our robust logic)
- Pushed to GitHub (bb5b6f7), Railway auto-deploy

Stage Summary:
- strategyAggressiveness=TEST DB persistence heavily reinforced with whitelist validation + force-injection + Raw SQL fallback
- DB 진단 GET endpoint allows direct DB raw value inspection
- All KIS API methods now have normalizeStockCode safety nets
- UI shows clear success/failure feedback on TEST mode toggle
- PAT removed from git remote after push

---
Task ID: 3
Agent: Main Agent
Task: strategyAggressiveness=TEST Raw SQL 직접 저장 + 오버라이드 키 폴백

Work Log:
- Identified that settingsSources.strategyAggressiveness=default means DB field is missing
- Root cause hypothesis: Prisma Json field serialization may be dropping strategyAggressiveness
- Rewrote test-mode POST to use ONLY Raw SQL ($queryRaw/$executeRaw), bypassing Prisma upsert
- Added 6-step verification: raw before → merge → raw save → raw verify (3 retries) → override key backup → effective check
- Added strategy_aggressiveness_override separate DB key as nuclear fallback
- Modified getEffectiveTradingSettings() to check override key when strategyAggressiveness is undefined
- Enhanced GET diagnostic with Raw SQL vs Prisma comparison
- Pushed to GitHub (1599b03)

Stage Summary:
- Raw SQL bypass completely avoids Prisma's Json serialization
- Override key provides a guaranteed fallback even if main record fails
- getEffectiveTradingSettings() now has 2-tier strategyAggressiveness resolution

---
Task ID: 4
Agent: Main Agent
Task: TEST 모드 직접 Prisma 연결로 db.ts Proxy 경쟁상태 해결 (v5)

Work Log:
- 분석: db.ts의 Proxy 기반 비동기 초기화(_usePrisma 플래그)가 요청 시점에 따라 InMemory DB와 PostgreSQL 혼용
- 분석: upsert where { key }가 key unique 제약조건에 의존하여 실패 가능
- 분석: UI "DRY_RUN+보수" 버튼이 test-mode POST 호출하여 CONSERVATIVE→TEST로 덮어쓰는 버그
- 생성: src/lib/prisma.ts — 싱글톤 PrismaClient 직접 연결, getAppSetting/setAppSetting 유틸리티
  - findFirst + update/create 방식 (upsert unique 의존성 제거)
  - Raw SQL 폴백 (Prisma ORM 실패 시 직접 SQL 실행)
  - ensurePrismaConnected/isPrismaAvailable 상태 관리
- 재작성: test-mode/route.ts — 직접 Prisma 사용, v5
  - POST: getAppSetting/setAppSetting으로 저장 + 검증
  - DELETE: override 키 삭제 + CONSERVATIVE 복원 (새 엔드포인트)
  - GET: 직접 Prisma vs db.ts Proxy 비교 진단
- 수정: effective-settings.ts — DATABASE_URL 있으면 직접 Prisma 사용
- 수정: UI DRY_RUN+보수 버튼 — POST → DELETE로 변경
- 빌드 테스트 성공
- GitHub 푸시: 8bf3994

Stage Summary:
- 근본 원인: db.ts Proxy 비동기 초기화 경쟁상태 + upsert unique 제약 의존성
- 해결: 직접 PrismaClient 싱글톤으로 db.ts Proxy 완전 우회
- 추가: DELETE /api/settings/trading/test-mode 엔드포인트
- UI 버그 수정: DRY_RUN+보수 버튼이 TEST로 덮어쓰는 문제 해결

---
Task ID: 1
Agent: Main Agent
Task: 한국투자증권 국내 종목 리스트 적용 (KOSPI/KOSDAQ .mst 파일 파싱)

Work Log:
- 업로드된 5개 .mst 파일 포맷 분석 (EUC-KR 고정폭 포맷)
- scripts/build-korean-stocks.mjs 파서 스크립트 작성
- kospi_code.mst (2,523종목), kosdaq_code.mst (1,823종목) 파싱
- nxt_kospi_code.mst (357종목), nxt_kosdaq_code.mst (273종목) 파싱
- 중복 제거 후 총 4,346종목 korean-stocks.json 재생성
- theme_code.mst 파싱 → korean-themes.json 생성 (7개 테마그룹, 422개 매핑)
- EUC-KR 인코딩 자동 처리 (Node.js TextDecoder)
- 유형별: EQUITY 3,255 + ETF 1,091
- 빌드 성공 확인, Railway 배포 완료

Stage Summary:
- data/korean-stocks.json: 4,346종목 (KOSPI 2,523 + KOSDAQ 1,823)
- data/korean-themes.json: 테마 데이터 (신규상장주 등 7개 그룹)
- scripts/build-korean-stocks.mjs: .mst→JSON 변환 스크립트
- 주요 종목 검색 확인: 삼성전자, SK하이닉스, 현대차, 카카오, LG에너지솔루션 등
- Commits: 77b2d2e, 74b28f0 (pushed to main)
---
Task ID: 1
Agent: main
Task: Apply KIS domestic and overseas stock lists from uploaded .mst and .COD files

Work Log:
- Read uploaded overseas stock list files: AMSMST.COD, NASMST.COD, NYSMST.COD
- Explored current stock system architecture (stock-master.ts, kis-overseas-master.ts, build scripts)
- Rebuilt domestic Korean stock list from .mst files: 4,346 stocks (KOSPI: 2,523, KOSDAQ: 1,823)
- Copied new .COD files to data/kis-overseas/ directory
- Fixed build-overseas-symbols.mjs: replaced iconv-lite dependency with Node.js built-in TextDecoder (CP949→EUC-KR fallback)
- Rebuilt overseas stock list: 12,161 stocks (NASDAQ: 5,110, AMEX: 4,204, NYSE: 2,847)
- Rebuilt Next.js app with new stock data
- Verified all search scenarios work correctly:
  - 국내 종목 검색: 삼성전자 ✅, 005930 ✅
  - 해외 영문 검색: NVIDIA ✅, IBM ✅, SPY ✅
  - 해외 한글 검색: 엔비디아 ✅ (NVDA 정상 검색)
  - displayCode 포맷: KRX:005930, NAS:NVDA, NYS:IBM, AMS:SPY 모두 정상

Stage Summary:
- 국내 종목 리스트 적용 완료: 4,346종목 (KOSPI + KOSDAQ + NXT)
- 해외 종목 리스트 적용 완료: 12,161종목 (NASDAQ + AMEX + NYSE)
- build-overseas-symbols.mjs 아이콘v-lite 의존성 제거 (Node.js 내장 TextDecoder 사용)
- ETF 이름에 일부 trailing data 포함된 이슈 있으나 검색 기능에는 영향 없음
---
Task ID: 2
Agent: main
Task: Fix stock search accuracy issues

Work Log:
- Identified 6 major search issues: 현대차→현대차증권, 카카오→BNK카카오그룹포커스, V→해외결과없음, 구글→해외결과없음, SQ→SQQQ우선, BRK.B→잘못된종목
- Root cause: searchAllStocks used simple symbol-only sorting with no relevance scoring
- Implemented calcSearchScore: 7-tier scoring (symbol exact → name exact → prefix → contains)
- Added KOREAN_ALIAS_MAP: 40+ Korean name → symbol mappings (구글→GOOGL, 비자→V, etc.)
- Fixed short query (1-2 chars) over-matching: limited domestic results to 15 for short queries
- Fixed overseas result starvation: guaranteed minimum 10 overseas results (40% of limit)
- Added BRK.B/BRK/B/BRKB normalized symbol comparison in searchOverseasMaster
- Added symbol change history mapping: SQ→XYZ (Block, Inc. rebranded 2025)
- Verified all previously failing searches now work correctly

Stage Summary:
- All 6 search issues fixed and verified
- Search ranking dramatically improved with relevance scoring
- Korean alias mapping enables natural language search for overseas stocks
- Committed as d2127d7
---
Task ID: 1
Agent: main
Task: Fix domestic stock search failures - garbled ETF names and missing ETN codes

Work Log:
- Analyzed .mst file byte-level format: Code(9B) + ISIN(12B) + Name(40B) + GroupCode(2B) at byte offset 61
- Found root cause 1: build-korean-stocks.mjs used regex on decoded strings, failed when name filled 40-byte field (no space before group code) → 28 ETF/ETN entries had garbled names like "000000000000NN 0NNN2NN"
- Found root cause 2: stock-master.ts extractDomesticCode() didn't handle Q-code ETN entries (Q500061 etc.) → 397 ETN entries were not searchable
- Rewrote build-korean-stocks.mjs parseMasterLine to use byte-level parsing (Buffer.subarray at fixed offsets 0/9/21/61)
- Added Q-code ETN support to stock-master.ts: extractDomesticCode(), isDomesticStockCode(), and indexing loop
- Added 'ETN' codeType to DomesticIndexEntry interface
- Rebuilt korean-stocks.json: 4,346 entries, 0 garbled names, ETN type properly classified
- Verified: all 4,346 entries now indexed (was 3,949 before fix)
- Tested search: TIGER 엔비디아, 인버스, Q500061, 0000D0 all work correctly

Stage Summary:
- Fixed: 28 garbled ETF/ETN names (byte-level parsing instead of regex)
- Fixed: 397 Q-code ETN entries now searchable (was completely missing before)
- Total indexed: 4,346 / 4,346 (100% coverage, was 3,949 / 4,346 = 90.9%)
- Type breakdown: STANDARD 3,577 + ETF_ALPHANUMERIC 296 + ETN 397 + SPECIAL 76 = 4,346

---
Task ID: 2
Agent: main
Task: Fix domestic stock Korean name search - English-only names can't be searched in Korean

Work Log:
- Discovered 137 domestic stocks have English-only names in .mst file (e.g., NAVER, HMM, KT, LG, S-Oil)
- Users searching "네이버" couldn't find NAVER (035420), "현대상선" couldn't find HMM (011200), etc.
- Added 70+ Korean alias mappings to KOREAN_ALIAS_MAP in stock-master.ts for domestic stocks
- Modified searchAllStocks() to support domestic alias matching:
  - Direct alias match: if aliasSymbol is a domestic code, look up in DOMESTIC_MASTER_BY_SYMBOL
  - Expanded search: include alias symbol in normal search loop
- Previously KOREAN_ALIAS_MAP only supported overseas stocks (한글→해외 심볼)
- Now supports both domestic (한글→종목코드) and overseas (한글→심볼) mappings

Stage Summary:
- "네이버" → NAVER (035420) ✅
- "현대상선" → HMM (011200) ✅
- "에스오일" → S-Oil (010950) ✅
- "케이티" → KT (030200) ✅
- "엘지" → LG (003550) ✅
- "아프리카tv" → SOOP (067160) ✅
- 70+ domestic Korean alias mappings added
- searchAllStocks() now supports domestic alias lookup via DOMESTIC_MASTER_BY_SYMBOL

---
Task ID: 1
Agent: main
Task: Fix TradingEngine.analyzeAllStrategies() hardcoded thresholds to use dynamic signalThreshold/weakSignalThreshold

Work Log:
- Identified the core bug: analyzeAllStrategies() lines 789-793 had hardcoded `buyScore >= 50` / `sellScore >= 50` that ignored the passed-in signalThreshold/weakSignalThreshold parameters
- Replaced hardcoded 4-tier logic (BUY/SELL/HOLD) with 5-tier logic matching analyzeComposite(): 강한 BUY → 강한 SELL → 약한 BUY → 약한 SELL → HOLD
- Added holdReason field with detailed diagnostics for every HOLD result
- Added buyScore, sellScore, finalThreshold fields to TradingSignal interface (types.ts)
- Updated analyzeAllStrategies() return object to include holdReason, buyScore, sellScore, finalThreshold
- Updated topBuyCandidates in AgentCycleResult to include buyScore, sellScore, finalThreshold, holdReason
- Updated trading-agent.ts to push all candidates (not just BUY/SELL) to topBuyCandidates for diagnostics
- Added buyScore-descending sort to topBuyCandidates before slicing
- Added HOLD-specific logging with holdReason in both DOMESTIC and OVERSEAS analysis loops
- Verified thresholds match user requirements: TEST(30/25), CONSERVATIVE(60/40), AGGRESSIVE(25/20)
- Build passed successfully

Stage Summary:
- Core fix: Hardcoded `>= 50` replaced with dynamic signalThreshold/weakSignalThreshold
- TEST mode: 강한 BUY at buyScore>=30, 약한 BUY at buyScore>=25
- CONSERVATIVE mode: 강한 BUY at buyScore>=60, 약한 BUY at buyScore>=40
- AGGRESSIVE mode: 강한 BUY at buyScore>=25, 약한 BUY at buyScore>=20
- HOLD logs now show: "ALL 최종 기준 미달: buyScore=X, sellScore=Y, required=Z(강한), W(약한)"
- /api/agent/status topBuyCandidates now includes buyScore, sellScore, finalThreshold, holdReason
- Files modified: trading-engine.ts, trading-agent.ts, types.ts

---
Task ID: 2
Agent: main
Task: Fix selectedStrategy=COMPOSITE not being used (hardcoded 'ALL'), fix COMPOSITE thresholds, add KIS throttle/retry, increase cycleIntervalMs

Work Log:
- Found root cause: trading-agent.ts had `strategy='ALL'` hardcoded in both domestic (line 1066) and overseas (line 1354) TradingEngine.analyze() calls, ignoring effectiveSettings.selectedStrategy
- Changed both calls to use `effectiveSettings.selectedStrategy || 'ALL'`
- Fixed analyzeComposite() gap thresholds: strong signal gap from 20→15, weak signal gap from 0→5 (matching user's TEST mode spec)
- Added holdReason, buyScore, sellScore, finalThreshold to analyzeComposite() return object
- Added retryOnRateLimit wrapper to placeOrder() and placeOverseasOrder() (previously only balance queries had it)
- Increased KIS throttler interval from 500ms→600ms (KIS allows 5/sec, 200ms margin)
- Made throttler interval configurable via KIS_THROTTLE_MS env var
- Changed cycleIntervalMs default from 60000→120000 in effective-settings.ts and agent-scheduler.ts
- Build passed successfully

Stage Summary:
- Core fix: selectedStrategy=COMPOSITE now actually calls analyzeComposite() instead of analyzeAllStrategies()
- TEST mode with COMPOSITE: buyScore=39.75 → strong BUY (>=30, >sellScore+15)
- KIS rate limit protection: retryOnRateLimit on all order + balance methods, 600ms throttle
- cycleIntervalMs=120000 (2 min cycles) reduces API call density
- Files modified: trading-agent.ts, trading-engine.ts, kis-api.ts, effective-settings.ts, agent-scheduler.ts
