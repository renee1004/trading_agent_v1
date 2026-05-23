---
Task ID: 1
Agent: main
Task: getEffectiveTradingSettings() 공통 함수 생성 및 모든 모듈 통합

Work Log:
- src/lib/effective-settings.ts 신규 생성
  - getEffectiveTradingSettings(): DB > 환경변수 > 안전 기본값 우선순위
  - buildRiskConfigFromSettings(): DB 설정을 RiskConfig로 변환
  - formatSettingsSummary(): 설정 요약 로그 출력
  - 위험 옵션 이중 게이트: DB OR 환경변수에서 명시적 true일 때만 활성화
- src/lib/trading-agent.ts 수정
  - 환경변수 직접 읽기(ENABLE_OVERSEAS_*) 제거
  - getOverseasSettings() 제거 → getEffectiveTradingSettings()로 대체
  - runAgentCycle() 시작 시 await getEffectiveTradingSettings() 호출
  - executeOrder()에 settings 파라미터 추가 (enableOverseasOrder, allowAfterHoursTrading)
  - getDomesticOrderPolicy()에 allowAfterHoursTrading 파라미터 추가
  - monitorPositions()에 settings 파라미터 추가 (RiskManager에 DB 리스크 설정 적용)
  - RiskManager 생성: buildRiskConfigFromSettings() 사용
- src/app/api/agent/status/route.ts 수정
  - getEffectiveTradingSettings() 사용 → 실제 에이전트 실행 설정과 100% 일치
  - settingsSources 필드 추가 (개별 필드별 소스 추적)
  - getOverseasSettings() import 제거
- src/app/api/settings/trading/route.ts 수정
  - GET/POST 모두 getEffectiveTradingSettings() 사용
  - POST 후 getEffectiveTradingSettings() 재호출하여 안전 오버라이드 정확히 반영
- src/lib/agent-scheduler.ts 수정
  - loadSchedulerConfig()에서 getEffectiveTradingSettings() 호출
  - AppSetting(trading_settings)의 cycleIntervalMs, tradeOnlyMarketHours 반영
  - 사용자가 대시보드에서 저장한 설정이 실제 스케줄러 인터벌에 적용

Stage Summary:
- 배포 검증 완료 (commit: a46751bd)
- domesticSuccess: 10, domesticFailed: 0 ✅
- settingsSource: db ✅
- settingsSources 추적 정상 ✅
- maxOpenPositions DB 변경 → 다음 사이클 반영 확인 ✅
- 위험 옵션 안전장치: enableOverseasOrder=false, allowAfterHoursTrading=false ✅
---
Task ID: balance-500-fix
Agent: main
Task: 국내/해외 포지션 조회 실패 500 에러 해결

Work Log:
- 분석: 국내/해외 잔고조회 코드에서 HTTP 500 응답 시 response body를 읽지 않고 상태코드만 throw → rt_cd/msg_cd/msg1 유실
- 원인 파악: 해외 잔고조회 500 = EGW00201 (초당 거래건수 초과), 국내 잔고조회는 정상 성공
- maskAccountNo() 추가: 계좌번호 앞2자리+****+뒤2자리 마스킹
- getAccountBalance: HTTP 에러 시 response body에서 rt_cd/msg_cd/msg1 추출하여 throw message에 포함
- getOverseasAccountBalance: 동일하게 HTTP 에러 시 상세 에러 정보 추출
- 잔고조회 요청 상세 로그 추가 (endpoint, tr_id, accountMasked, isDemo, params)
- fetchPositions: KIS 에러 상세(rt_cd/msg_cd/msg1)를 addLog details에 전파
- loadKisConfig: 계좌번호 마스킹 적용
- retryOnRateLimit() 래퍼 추가: EGW00201 감지 시 지수 백오프 재시도 (3회, 500ms→1s→2s)
- getAccountBalance, getOverseasAccountBalance에 retryOnRateLimit 적용

Stage Summary:
- commit 59915fd: 잔고조회 500 에러 상세 로깅 + 계좌번호 마스킹
- commit a02cb5d: EGW00201 속도제한 재시도 로직 추가
- Railway 배포 확인: a02cb5d 배포 완료
- 포지션 조회 실패 로그 완전히 사라짐 (국내/해외 모두 정상)
- 분석 결과: 국내 10종목 성공/0실패, 해외 5종목 성공/0실패
