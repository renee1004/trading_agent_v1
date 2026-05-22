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
