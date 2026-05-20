---
Task ID: 1
Agent: Main Agent
Task: 한국투자증권 자동매매 AI Trading Agent 구축

Work Log:
- 한국투자증권 KIS Open API 리서치 (인증, 시세조회, 주문, 잔고 API)
- 인터넷/유튜브 수익률 높은 매매전략 리서치 (5대 전략 도출)
- Prisma 스키마 설계 (KisConfig, TradingStrategy, TradeHistory, Position, TradingSession, RiskConfig, MarketData, WatchlistItem)
- KIS API 클라이언트 구현 (인증, 시세조회, 일봉조회, 주문, 잔고, 주문취소)
- 기술적 지표 라이브러리 구현 (RSI, MACD, Bollinger Bands, SuperTrend, ATR, SMA, EMA)
- 5대 매매전략 엔진 구현 (복합지표, 변동성돌파, SuperTrend추세추종, 평균회귀, 모멘텀)
- 종합 분석 (5대 전략 가중평균 AI 에이전트) 구현
- 리스크 관리 모듈 구현 (포지션사이즈, 손절/익절, 트레일링스톱, 일일/총손실한도)
- API 라우트 9개 구현 (KIS설정, 토큰, 시세, 잔고, 주문, 매매신호, 거래내역, 세션관리, 전략목록, 리스크설정, 관심종목)
- 웹 대시보드 UI 구현 (5개 탭: 대시보드, 매매신호, 포지션, 전략, 리스크)
- Lint 검증 통과

Stage Summary:
- 완전한 자동매매 AI Agent 시스템 구축 완료
- 5대 전략: COMPOSITE(4중검증), VOLATILITY_BREAKOUT(래리윌리엄스), SUPER_TREND(153-299%백테스트), MEAN_REVERSION(BB+RSI), MOMENTUM(거래량폭증)
- 7개 기술적 지표: RSI, MACD, Bollinger Bands, SuperTrend, ATR, SMA, EMA
- 전략별 가중치: COMPOSITE 35%, SUPER_TREND 25%, VOLATILITY_BREAKOUT 15%, MEAN_REVERSION 15%, MOMENTUM 10%
- KIS API 완전 연동 (모의/실전 토글)
- 종합 리스크 관리 시스템 (7단계 안전장치)
