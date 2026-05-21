# AI Trading Agent v1

한국투자증권(KIS) Open API 기반 자동매매 AI 에이전트

## 기능

- **5대 매매 전략**: COMPOSITE(35%), SUPER_TREND(25%), VOLATILITY_BREAKOUT(15%), MEAN_REVERSION(15%), MOMENTUM(10%)
- **7개 기술적 지표**: RSI, MACD, Bollinger Bands, SuperTrend, ATR, SMA, EMA
- **7단계 리스크 관리**: 포지션 사이즈, 일일 손실, 총 손실, 최대 포지션, 손절/익절, 트레일링 스톱
- **국내+해외 주식**: 한국 주식 및 미국 주식(나스닥/뉴욕/아멕스) 동시 지원
- **24/7 서버 자동매매**: Railway 배포로 브라우저 없이 서버에서 자동 실행
- **모의투자 지원**: 실거래 전 모의투자로 안전하게 테스트
- **웹 대시보드**: 실시간 매매 신호, 포지션, 거래 내역 모니터링

## 기술 스택

- **Frontend**: Next.js 16, React 19, Tailwind CSS 4, shadcn/ui, Recharts
- **Backend**: Next.js API Routes, Prisma ORM
- **Database**: PostgreSQL (Railway)
- **API**: 한국투자증권 Open API (REST)
- **Deploy**: Railway (Docker)

## 빠른 시작

### 1. 로컬 개발

```bash
# 저장소 클론
git clone https://github.com/renee1004/trading_agent_v1.git
cd trading_agent_v1

# 의존성 설치
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일에서 DATABASE_URL 설정

# 데이터베이스 마이그레이션
npx prisma migrate dev

# 개발 서버 실행
npm run dev
```

### 2. KIS API 설정

1. [한국투자증권](https://koreainvestment.com) 로그인
2. **MTS/HTS > 서비스신청 > Open API 신청**
3. 모의투자 신청 후 **App Key / App Secret** 발급
4. 대시보드의 **API 설정** 버튼으로 키 입력

### 3. Railway 배포

자세한 내용은 아래 Railway 배포 섹션 참고

## 대시보드 탭

| 탭 | 설명 |
|---|---|
| 대시보드 | 총 자산, 수익률, 매매 신호, 포지션 요약 |
| 에이전트 | 24/7 자동매매 에이전트 제어 및 로그 |
| 매매신호 | 5대 전략 종합 분석 매수/매도 타점 |
| 관심종목 | 종목 검색 및 관심종목 관리 |
| 해외주식 | 미국 주식 포지션 및 검색 |
| 전략 | 매매 전략별 상세 설정 |
| 리스크 | 리스크 관리 파라미터 설정 |

## Railway 배포 가이드

### 1단계: GitHub 저장소 준비

```bash
# GitHub에 trading_agent_v1 저장소 생성 후
git remote add origin https://github.com/renee1004/trading_agent_v1.git
git push -u origin main
```

### 2단계: Railway 프로젝트 생성

1. [railway.app](https://railway.app) 로그인 (GitHub 계정으로)
2. **New Project** > **Deploy from GitHub repo**
3. `renee1004/trading_agent_v1` 선택

### 3단계: PostgreSQL 추가

1. 프로젝트에서 **New** > **Database** > **PostgreSQL**
2. Railway가 자동으로 `DATABASE_URL` 환경변수 설정

### 4단계: 환경변수 설정

웹 서비스의 **Variables** 탭에서 설정:

| 변수 | 값 | 필수 |
|---|---|---|
| `DATABASE_URL` | PostgreSQL 추가 시 자동 설정 | 자동 |
| `KIS_APP_KEY` | KIS API App Key | 선택 (대시보드에서 입력 가능) |
| `KIS_APP_SECRET` | KIS API App Secret | 선택 |
| `KIS_ACCOUNT_NO` | 계좌번호 (예: 50123456-01) | 선택 |
| `KIS_IS_DEMO` | `true` (모의투자) | 선택 |

### 5단계: 배포 완료

- Railway가 자동으로 Dockerfile 기반 빌드 실행
- 배포 완료 후 제공되는 URL로 대시보드 접속
- **API 설정** 버튼으로 KIS 키 입력 후 **에이전트 시작**

## 프로젝트 구조

```
trading_agent_v1/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── agent/          # 에이전트 제어 API
│   │   │   ├── kis/            # KIS API 라우트
│   │   │   │   └── overseas/   # 해외주식 API
│   │   │   ├── strategy/       # 전략 관리
│   │   │   ├── trading/        # 거래 실행
│   │   │   └── watchlist/      # 관심종목
│   │   ├── page.tsx            # 메인 대시보드
│   │   └── layout.tsx          # 레이아웃
│   ├── lib/
│   │   ├── kis-api.ts          # KIS API 클라이언트
│   │   ├── trading-agent.ts    # 자동매매 에이전트 코어
│   │   ├── agent-scheduler.ts  # 24/7 서버 스케줄러
│   │   ├── trading-engine.ts   # 전략 분석 엔진
│   │   ├── risk-manager.ts     # 리스크 관리
│   │   ├── indicators.ts       # 기술적 지표 계산
│   │   ├── market-defaults.ts  # 시장별 기본 설정
│   │   ├── types.ts            # 타입 정의
│   │   └── db.ts               # Prisma 클라이언트
│   └── components/ui/          # shadcn/ui 컴포넌트
├── prisma/
│   └── schema.prisma           # 데이터베이스 스키마
├── Dockerfile                  # Railway 배포용
├── railway.toml                # Railway 설정
├── start.sh                    # 시작 스크립트
└── .env.example                # 환경변수 템플릿
```

## 라이선스

Private Project
