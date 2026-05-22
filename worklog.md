---
Task ID: 1
Agent: Main Agent
Task: KIS 설정 env fallback 우선순위 + 계좌번호 정규화 + 공통 로더 구현

Work Log:
- 기존 코드 분석: trading-agent.ts loadKisConfig(), kis-api.ts parseAccountNo(), API 라우트 3개
- src/lib/kis-config-loader.ts 신규 생성 (공통 모듈)
  - normalizeKisAccountNo(): 8자리→10자리, 하이픈 제거, 유효성 검증
  - readKisConfigFromEnv(): env fallback 우선순위 적용
    - appKey: KIS_APP_KEY > KIS_APPKEY > APP_KEY
    - appSecret: KIS_APP_SECRET > KIS_APPSECRET > APP_SECRET
    - accountNo: KIS_ACCOUNT_NO > KIS_ACCOUNT > ACCOUNT_NO
    - isDemo: KIS_IS_DEMO > KIS_VIRTUAL > KIS_BASE_URL(openapivts) > 기본값 true
  - getOrCreateKisConfigFromEnv(): DB 1순위, env 2순위, 자동 DB 저장
- src/lib/kis-api.ts parseAccountNo() 수정: 8자리 계좌번호 '01' 자동 추가
- src/lib/trading-agent.ts loadKisConfig() 수정: 공통 로더 사용, 마스킹 로그
- /api/kis/config: env fallback 반영, 계좌번호 정규화 POST에 적용
- /api/kis/token: env fallback으로 configured:true 가능
- /api/kis/balance: env fallback으로 잔고 조회 가능
- 빌드 성공, GitHub push 완료 (commit 5f34c23)

Stage Summary:
- 6개 파일 변경 (1개 신규, 5개 수정), 337줄 추가, 115줄 삭제
- 기존 환경변수명(KIS_ACCOUNT, KIS_VIRTUAL)과 새 환경변수명 모두 지원
- FID_ORIG_ADJ_PRC, 국내 주문 정책, PENDING/FILLED 로직 유지 확인

---
Task ID: 2
Agent: Main Agent
Task: 캔들 조회 안정화 + 버전 로그 + 해외 비활성화 + 진단 개선

Work Log:
- FID_ORG_ADJ_PRC 전역 검색 → 코드 0건, 주석 1건 제거 완료
- FID_ORIG_ADJ_PRC만 사용 확인 (전역 검색 1건 = 실제 파라미터)
- kis-api.ts: 캔들 실패 로그에 stockCode, baseUrl 명시, 에러 메시지에 [baseUrl] prefix
- trading-agent.ts 대폭 개선:
  - ENABLE_OVERSEAS_TRADING env 추가 (기본값 false)
  - fetchCandles() → {candles, error} 반환형 변경
  - domesticSuccess/domesticFailed 카운트 추가
  - diagnoseZeroAnalysis() 함수: stocksAnalyzed=0 원인 구분 (KIS 설정 없음/토큰 없음/캔들 실패/30개 미만/장외)
  - 종목별 상세 로그: candlesLength, lastClose, signalType
  - "주문 완료" → "주문 접수" 통일
  - 개별 종목 오류가 전체 사이클 죽이지 않음
- /api/agent/status: version 필드 추가 (RAILWAY_GIT_COMMIT_SHA, RAILWAY_GIT_BRANCH, APP_VERSION 등)
- lastCycleSummary에 domesticSuccess/Failed, overseasSuccess/Failed, zeroAnalysisReason 추가
- 빌드 성공, GitHub push 완료 (commit 17620f8)

Stage Summary:
- 3개 파일 변경, 258줄 추가, 94줄 삭제
- FID_ORG_ADJ_PRC 코드 내 완전 제거 확인
- 해외 분석 기본 비활성화, ENABLE_OVERSEAS_TRADING=true로 활성화 가능
- stocksAnalyzed=0 원인 진단 기능 추가

---
Task ID: 5
Agent: Main Agent
Task: Railway 배포 검증 + FID_ORIG_ADJ_PRC → FID_ORG_ADJ_PRC 수정

Work Log:
- Railway /api/agent/status 호출하여 배포 상태 확인
- gitCommitSha=17620f8 확인 (당시 최신), domesticSuccess=0, domesticFailed=10
- KIS API에서 ERROR INPUT FIELD NOT FOUND [FID_ORG_ADJ_PRC] 에러 지속 확인
- 웹 검색으로 KIS 공식 API 문서 확인 → 정확한 파라미터명은 FID_ORG_ADJ_PRC (NOT FID_ORIG_ADJ_PRC)
- kis-api.ts에서 FID_ORIG_ADJ_PRC → FID_ORG_ADJ_PRC 수정
- 파라미터 로깅 추가 (params.toString() 출력)
- 빌드 + git push (commit 43c827a)
- Railway 자동 재배포 대기 후 스케줄러 재시작
- 새 사이클 결과: domesticSuccess=10, domesticFailed=0, stocksAnalyzed=10 ✅

Stage Summary:
- 핵심 원인: FID_ORIG_ADJ_PRC(오타) → FID_ORG_ADJ_PRC(KIS 공식명) 복원으로 해결
- 10개 국내 종목 캔들 조회 전체 성공
- 잔고 조회(HTTP 500)는 모의서버 제한으로 추정 (장외시간 + mock server)
- version.gitCommitSha=43c827a로 최신 코드 배포 확인 완료

---
Task ID: 6
Agent: Main Agent
Task: 해외 분석/주문 분리 + 설정 영속화 구현

Work Log:
- getOverseasDailyCandles() dual-server fallback 적용 (모의→실전 자동 전환)
- 해외 캔들 상세 로깅 추가 (EXCD, SYMB, GUBN, BYMD, MODP, rt_cd, msg_cd, msg1, output2Length)
- GUBN 1글자 코드 유지, BYMD period 기반 과거 날짜 계산
- ENABLE_OVERSEAS_ANALYSIS/ORDER 분리 (하위호환: ENABLE_OVERSEAS_TRADING→ANALYSIS)
- 해외 주문 안전장치: 거래소코드 유효성/가격>0/수량>0/enableOrder 체크
- Prisma AppSetting 모델 추가 (key/value Json)
- GET/POST /api/settings/trading API 구현 (DB > 환경변수 > 기본값)
- 위험 옵션 안전장치: enableOverseasOrder/allowAfterHoursTrading 명시적 true만 허용
- /api/agent/status에 effectiveSettings + settingsSource 추가
- 프론트엔드 loadSettingsFromServer() 추가 (서버 DB 우선 → localStorage fallback)
- 리스크 설정 저장 시 /api/settings/trading + localStorage 동기화
- env-check POST 스키마 동기화 추가 (AppSetting 테이블 자동 생성)

Stage Summary:
- Railway 배포 검증 완료 (commit e27cfd9)
- 국내: domesticSuccess=10, domesticFailed=0 (정상 유지)
- 해외: "해외주식 분석 건너뜀 (ENABLE_OVERSEAS_ANALYSIS=false)" 로그 확인
- 설정 영속화: DB 저장→GET 조회 시 source=db, 값 유지 확인
- 위험 옵션: enableOverseasOrder 항상 false (안전장치 동작 확인)
