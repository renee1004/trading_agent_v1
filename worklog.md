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
