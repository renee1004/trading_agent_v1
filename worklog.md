---
Task ID: 1
Agent: Main Agent
Task: 자동매매 에이전트 작동 구현

Work Log:
- 프로젝트 전체 구조 분석: 전략 엔진, KIS API, 리스크 매니저는 구현되어 있으나 시그널→주문 자동화 파이프라인이 없음을 확인
- trading-agent.ts 코어 로직 구현: runAgentCycle(), startAgent(), stopAgent(), getAgentStatus()
- 5개 에이전트 API 라우트 생성: /api/agent/{run,start,stop,status,logs}
- signals 라우트 실데이터 연동: Mock → KIS API 우선 시도, 실패 시 폴백
- 대시보드 UI 업데이트: 포지션 탭 → 에이전트 탭으로 교체, 제어 패널, 실행 로그, 자동실행 스위치 추가
- 빌드 테스트 성공, API 엔드포인트 전체 정상 동작 확인

Stage Summary:
- 자동매매 에이전트가 완전히 작동 가능한 상태가 됨
- 에이전트 시작/중지/1사이클실행/자동실행(60초간격) 모두 정상
- 시그널 분석→리스크체크→주문실행→포지션모니터링 전체 파이프라인 구현
- KIS API 설정 시 실데이터 사용, 미설정 시 모의 데이터로 동작
