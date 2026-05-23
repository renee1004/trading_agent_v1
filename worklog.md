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
---
Task ID: priority-1-8
Agent: main
Task: 1~8순위 수정/검증 항목 순차 진행

Work Log:
- 1순위 (cbbb589): TradeHistory 스키마 확장 (source, orderExecutionMode, currentPrice, orderPrice, filledPrice, avgFillPrice, slippagePercent, rtCd, msgCd, msg1)
  - 해외 주문 라우트: market=OVERSEAS, currency=USD 설정 (기존 누락 수정)
  - UI: 해외 $표시, 국내 원화 표시, 출처/실행모드 뱃지, 슬리피지 표시
  - 거래내역 API: KRW/USD 통계 분리
- 2순위 (4d7d005): getOverseasCurrentPrice() retryOnRateLimit 적용
  - getOverseasDailyCandles() 루프 내 EGW00201 감지 + 2회 재시도
  - HTTP 500 시 rt_cd/msg_cd/msg1 추출 로깅
- 3순위 (4bc936a): KisApiThrottler 추가 (350ms 간격, HIGH/NORMAL/LOW 우선순위)
  - 11개 메서드에 kisThrottler.acquire() 적용
- 4순위: DRY_RUN 테스트 PASSED (canPlaceOrder=false, blockedReason="주문 드라이런: 실제 주문 차단", ordersPlaced=0)
- 6순위: 1순위에서 스키마 확장으로 함께 완료
- 7순위 (a4da1a1): validateOrderExecution에 availableAmount 부족/조회불가 시 주문 차단 추가
- 8순위 (a4da1a1): LIVE 안전장치 재확인 (기본 DRY_RUN, LIVE+allowReal=false→DRY_RUN 강등, killSwitch)

Stage Summary:
- Commits: cbbb589, 4d7d005, 4bc936a, a4da1a1
- Railway version: a4da1a1
- 국내 10/0, 해외 5/0, 포지션 조회 실패 없음
- 5순위 PAPER 테스트는 미국장 OPEN 시간(KST 23:30~06:00)에 진행 필요
