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
