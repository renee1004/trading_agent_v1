// 메인 대시보드 페이지
// 한국투자증권 AI 자동매매 Trading Agent

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  TrendingUp, TrendingDown, Play, Pause, Square, RefreshCw,
  Settings, Activity, BarChart3, Shield, Zap, Bot,
  Wallet, ArrowUpRight, ArrowDownRight, Clock, Eye,
  Plus, Trash2, CheckCircle, XCircle, AlertTriangle,
  LineChart, CandlestickChart, Target, Coins, Search, Star, Globe,
  RotateCw, Terminal, CircleDot
} from 'lucide-react';

// 타입 정의
interface SignalData {
  stockCode: string;
  stockName: string;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  strategy: string;
  confidence: number;
  price: number;
  reason: string;
  indicators: Record<string, number>;
  timestamp: string;
}

interface PositionData {
  stockCode: string;
  stockName: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  profitLoss: number;
  profitRate: number;
  evaluationAmount: number;
}

interface TradeData {
  id: string;
  stockCode: string;
  stockName: string;
  tradeType: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  totalAmount: number;
  strategy: string;
  status: string;
  signalReason?: string;
  tradedAt: string;
  market?: string;
  exchangeCode?: string;
  currency?: string;
  source?: string;
  orderExecutionMode?: string;
  currentPrice?: number;
  orderPrice?: number;
  filledPrice?: number;
  avgFillPrice?: number;
  slippagePercent?: number;
}

interface StrategyData {
  id: string;
  name: string;
  type: string;
  description: string;
  parameters: string;
  isActive: boolean;
  profitRate: number;
  winRate: number;
}

interface WatchlistItem {
  id: string;
  stockCode: string;
  stockName: string;
  sector: string | null;
  isActive: boolean;
}

interface SearchResult {
  market: 'DOMESTIC' | 'OVERSEAS' | 'UNKNOWN';
  exchangeCode: string;
  symbol: string;
  displayCode: string;
  stockName: string;
  koreanName?: string;
  englishName?: string;
  currency: 'KRW' | 'USD';
  source: string;
}

interface OverseasPositionData {
  stockCode: string;
  stockName: string;
  exchangeCode: string;
  exchangeName: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  profitLoss: number;
  profitRate: number;
  evaluationAmount: number;
  foreignEvaluation: number;
  exchangeRate: number;
  currency: string;
}

// OverseasSearchResult는 이제 SearchResult와 통합됨 (market='OVERSEAS'로 구분)

// 금액 포맷
function formatMoney(amount: number): string {
  if (Math.abs(amount) >= 100000000) {
    return `${(amount / 100000000).toFixed(1)}억`;
  }
  if (Math.abs(amount) >= 10000) {
    return `${(amount / 10000).toFixed(0)}만`;
  }
  return amount.toLocaleString('ko-KR');
}

function formatFullMoney(amount: number): string {
  return new Intl.NumberFormat('ko-KR').format(amount);
}

// 신호 배지
function SignalBadge({ type }: { type: string }) {
  if (type === 'BUY') {
    return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-200 hover:bg-emerald-500/25"><TrendingUp className="w-3 h-3 mr-1" />매수</Badge>;
  }
  if (type === 'SELL') {
    return <Badge className="bg-red-500/15 text-red-600 border-red-200 hover:bg-red-500/25"><TrendingDown className="w-3 h-3 mr-1" />매도</Badge>;
  }
  return <Badge variant="secondary">관망</Badge>;
}

// 전략 타입 배지
function StrategyTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    'COMPOSITE': 'bg-violet-500/15 text-violet-600 border-violet-200',
    'VOLATILITY_BREAKOUT': 'bg-amber-500/15 text-amber-600 border-amber-200',
    'SUPER_TREND': 'bg-sky-500/15 text-sky-600 border-sky-200',
    'MEAN_REVERSION': 'bg-teal-500/15 text-teal-600 border-teal-200',
    'MOMENTUM': 'bg-rose-500/15 text-rose-600 border-rose-200',
    'ALL': 'bg-indigo-500/15 text-indigo-600 border-indigo-200',
  };
  return (
    <Badge variant="outline" className={colors[type] || 'bg-gray-500/15 text-gray-600 border-gray-200'}>
      {type}
    </Badge>
  );
}

export default function TradingDashboard() {
  // 상태 관리
  const [tradingStatus, setTradingStatus] = useState<'RUNNING' | 'STOPPED' | 'PAUSED'>('STOPPED');
  const [signals, setSignals] = useState<SignalData[]>([]);
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [trades, setTrades] = useState<TradeData[]>([]);
  const [strategies, setStrategies] = useState<StrategyData[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState('ALL');
  const [isLoading, setIsLoading] = useState(false);
  const [accountBalance, setAccountBalance] = useState(0);
  const [todayProfit, setTodayProfit] = useState(0);
  const [totalProfitRate, setTotalProfitRate] = useState(0);
  const [dataSource, setDataSource] = useState<'api' | 'mock' | 'error'>('mock'); // 데이터 출처
  const [kisConnectionError, setKisConnectionError] = useState(''); // KIS 연결 에러 메시지
  const [kisConfigured, setKisConfigured] = useState(false);
  const [kisHasToken, setKisHasToken] = useState(false);
  const [kisTokenError, setKisTokenError] = useState('');
  const [kisTokenLoading, setKisTokenLoading] = useState(false);
  const [tokenCooldown, setTokenCooldown] = useState(0); // 재발급 쿨다운 (초)
  const [activeTab, setActiveTab] = useState('dashboard');

  // KIS 설정 다이얼로그
  const [showKisDialog, setShowKisDialog] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false); // 수정 모드 여부
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [isDemo, setIsDemo] = useState(true);
  // 저장된 설정 (마스킹된)
  const [savedAppKeyMasked, setSavedAppKeyMasked] = useState('');
  const [savedAccountNo, setSavedAccountNo] = useState('');
  const [savedIsDemo, setSavedIsDemo] = useState(true);

  // 리스크 설정
  const [riskConfig, setRiskConfig] = useState({
    maxPositionSize: 10,
    maxDailyLoss: 3,
    maxTotalLoss: 10,
    maxOpenPositions: 5,
    stopLoss: 5,
    takeProfit: 15,
    trailingStop: 3,
  });

  // 종목 검색/관심종목 상태
  const [showSearchDialog, setShowSearchDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);

  // 에이전트 상태
  const [agentStatus, setAgentStatus] = useState<{
    isRunning: boolean;
    lastCycleTime: string | null;
    totalCycles: number;
    totalTrades: number;
    lastCycleSummary: {
      stocksAnalyzed: number;
      signalsGenerated: number;
      ordersPlaced: number;
      positionsMonitored: number;
      exitsExecuted: number;
    } | null;
  } | null>(null);
  const [agentLogs, setAgentLogs] = useState<Array<{
    id: string;
    timestamp: string;
    type: string;
    market: string;
    message: string;
  }>>([]);
  const [isRunningCycle, setIsRunningCycle] = useState(false);
  const [autoCycleEnabled, setAutoCycleEnabled] = useState(false);

  // 서버 스케줄러 상태
  const [schedulerInfo, setSchedulerInfo] = useState<{
    isSchedulerRunning: boolean;
    schedulerMode: string;
    isCycleRunning: boolean;
    errorCount: number;
    startedAt: string | null;
    lastCycleAt: string | null;
    nextCycleAt: string | null;
    isMarketOpen: { domestic: boolean; overseas: boolean };
    config: {
      cycleIntervalMs: number;
      tradeOnlyMarketHours: boolean;
      domesticMarketOpen: string;
      domesticMarketClose: string;
      overseasMarketOpen: string;
      overseasMarketClose: string;
    };
    totalCycles: number;
    totalTrades: number;
    currentKST: string;
    domesticSession: {
      session: string;
      orderDivision: string;
      label: string;
    };
  } | null>(null);
  const [agentMode, setAgentMode] = useState<'SERVER' | 'BROWSER'>('SERVER');

  // 해외주식 상태
  const [marketType, setMarketType] = useState<'DOMESTIC' | 'OVERSEAS'>('DOMESTIC');
  const [overseasPositions, setOverseasPositions] = useState<OverseasPositionData[]>([]);
  const [overseasBalance, setOverseasBalance] = useState(0);
  const [overseasProfitRate, setOverseasProfitRate] = useState(0);
  const [overseasAvailable, setOverseasAvailable] = useState(0);
  const [overseasSearchResults, setOverseasSearchResults] = useState<SearchResult[]>([]);
  const [isOverseasSearching, setIsOverseasSearching] = useState(false);
  const [overseasSearchQuery, setOverseasSearchQuery] = useState('');
  const [showOverseasSearchDialog, setShowOverseasSearchDialog] = useState(false);

  // 데이터 로드
  // 서버 DB에서 설정 로드 (진실의 원천: DB > 환경변수 > 기본값)
  const loadSettingsFromServer = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/trading');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data) {
          const s = data.data;
          // riskConfig 업데이트 (서버 저장값 우선, localStorage 덮어쓰기 방지)
          setRiskConfig(prev => ({
            maxPositionSize: s.maxPositionSize !== undefined ? Math.round(s.maxPositionSize * 100) : prev.maxPositionSize,
            maxDailyLoss: s.maxDailyLoss !== undefined ? Math.round(s.maxDailyLoss * 100) : prev.maxDailyLoss,
            maxTotalLoss: s.maxTotalLoss !== undefined ? Math.round(s.maxTotalLoss * 100) : prev.maxTotalLoss,
            maxOpenPositions: s.maxOpenPositions !== undefined ? s.maxOpenPositions : prev.maxOpenPositions,
            stopLoss: s.stopLossPercent !== undefined ? Math.round(s.stopLossPercent * 100) : prev.stopLoss,
            takeProfit: s.takeProfitPercent !== undefined ? Math.round(s.takeProfitPercent * 100) : prev.takeProfit,
            trailingStop: s.trailingStopPercent !== undefined ? Math.round(s.trailingStopPercent * 100) : prev.trailingStop,
          }));
          // 전략 선택값 복원
          if (s.selectedStrategy) {
            setSelectedStrategy(s.selectedStrategy);
          }
          // localStorage에도 동기화 (서버값이 진실)
          localStorage.setItem('trading_settings', JSON.stringify(s));
        }
      }
    } catch (error) {
      // 서버 설정 로드 실패 시 localStorage fallback
      try {
        const stored = localStorage.getItem('trading_settings');
        if (stored) {
          const s = JSON.parse(stored);
          setRiskConfig(prev => ({
            maxPositionSize: s.maxPositionSize !== undefined ? Math.round(s.maxPositionSize * 100) : prev.maxPositionSize,
            maxDailyLoss: s.maxDailyLoss !== undefined ? Math.round(s.maxDailyLoss * 100) : prev.maxDailyLoss,
            maxTotalLoss: s.maxTotalLoss !== undefined ? Math.round(s.maxTotalLoss * 100) : prev.maxTotalLoss,
            maxOpenPositions: s.maxOpenPositions !== undefined ? s.maxOpenPositions : prev.maxOpenPositions,
            stopLoss: s.stopLossPercent !== undefined ? Math.round(s.stopLossPercent * 100) : prev.stopLoss,
            takeProfit: s.takeProfitPercent !== undefined ? Math.round(s.takeProfitPercent * 100) : prev.takeProfit,
            trailingStop: s.trailingStopPercent !== undefined ? Math.round(s.trailingStopPercent * 100) : prev.trailingStop,
          }));
          if (s.selectedStrategy) setSelectedStrategy(s.selectedStrategy);
        }
      } catch {}
    }
  }, []);

  const loadDashboardData = useCallback(async () => {
    try {
      // 잔고
      const balanceRes = await fetch('/api/kis/balance');
      if (balanceRes.ok) {
        const balanceData = await balanceRes.json();
        if (balanceData.success) {
          setAccountBalance(balanceData.data.totalDeposit);
          setTotalProfitRate(balanceData.data.totalProfitRate);
          setPositions(balanceData.data.positions || []);
          setDataSource(balanceData.source || 'api');
          setKisConnectionError(''); // 연결 성공 시 에러 초기화
        } else {
          // success: false but HTTP 200 — 비정상 케이스
          setKisConnectionError(balanceData.error || '잔고 조회 실패');
          setDataSource('error');
        }
      } else {
        // HTTP 에러 (400, 502 등)
        const errorData = await balanceRes.json().catch(() => null);
        const errorMsg = errorData?.error || `잔고 조회 실패 (HTTP ${balanceRes.status})`;
        const errorCode = errorData?.code || '';
        setKisConnectionError(errorMsg);
        setDataSource('error');
        // 설정 없음이면 configured도 false로
        if (errorCode === 'NO_KIS_CONFIG') {
          setKisConfigured(false);
        }
      }

      // 신호
      const signalRes = await fetch(`/api/trading/signals?strategy=${selectedStrategy}`);
      if (signalRes.ok) {
        const signalData = await signalRes.json();
        if (signalData.success) {
          setSignals(signalData.data.allSignals || []);
        }
      }

      // 거래 내역
      const tradeRes = await fetch('/api/trading/history?limit=20');
      if (tradeRes.ok) {
        const tradeData = await tradeRes.json();
        if (tradeData.success) {
          setTrades(tradeData.data.trades || []);
        }
      }

      // 전략
      const strategyRes = await fetch('/api/strategy/list');
      if (strategyRes.ok) {
        const strategyData = await strategyRes.json();
        if (strategyData.success) {
          setStrategies(strategyData.data || []);
        }
      }

      // 세션 상태
      const statusRes = await fetch('/api/trading/status');
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (statusData.success && statusData.data) {
          setTradingStatus(statusData.data.status || 'STOPPED');
        }
      }

      // 관심종목
      const watchlistRes = await fetch('/api/watchlist');
      if (watchlistRes.ok) {
        const watchlistData = await watchlistRes.json();
        if (watchlistData.success) {
          setWatchlist(watchlistData.data || []);
        }
      }
    } catch (error) {
      console.error('데이터 로드 실패:', error);
    }
  }, [selectedStrategy]);

  // 해외주식 데이터 로드
  const loadOverseasData = useCallback(async () => {
    try {
      const balanceRes = await fetch('/api/kis/overseas/balance');
      if (balanceRes.ok) {
        const balanceData = await balanceRes.json();
        if (balanceData.success) {
          setOverseasBalance(balanceData.data.totalDeposit);
          setOverseasProfitRate(balanceData.data.totalProfitRate);
          setOverseasAvailable(balanceData.data.availableAmount);
          setOverseasPositions(balanceData.data.positions || []);
        }
      }
    } catch (error) {
      console.error('해외주식 데이터 로드 실패:', error);
    }
  }, []);

  // 통합 종목 검색 (국내+해외, 로컬 마스터만 사용, KIS API 호출 없음)
  const searchStocks = useCallback(async (query: string) => {
    if (!query || query.length < 1) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(query)}&limit=30`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          // 국내 결과만 필터링
          setSearchResults((data.data || []).filter((r: SearchResult) => r.market === 'DOMESTIC'));
        }
      }
    } catch (error) {
      console.error('종목 검색 실패:', error);
    }
    setIsSearching(false);
  }, []);

  // 해외주식 검색 (동일 API 사용, 해외 결과만 필터링)
  const searchOverseasStocks = useCallback(async (query: string) => {
    if (!query || query.length < 1) {
      setOverseasSearchResults([]);
      return;
    }
    setIsOverseasSearching(true);
    try {
      const res = await fetch(`/api/stocks/search?q=${encodeURIComponent(query)}&limit=30`);
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          // 해외 결과만 필터링
          setOverseasSearchResults((data.data || []).filter((r: SearchResult) => r.market === 'OVERSEAS'));
        }
      }
    } catch (error) {
      console.error('해외주식 검색 실패:', error);
    }
    setIsOverseasSearching(false);
  }, []);

  // 관심종목 추가 (통합 SearchResult 사용)
  const addToWatchlist = async (stock: SearchResult) => {
    try {
      // displayCode를 stockCode로 사용 (KRX:005930, NAS:NVDA 등)
      if (isInWatchlist(stock.displayCode)) {
        return; // 이미 추가됨
      }
      const isOverseas = stock.market === 'OVERSEAS';
      const res = await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stockCode: stock.displayCode,
          stockName: isOverseas ? `[미] ${stock.koreanName || stock.stockName}` : stock.stockName,
          market: stock.market,
          exchangeCode: stock.exchangeCode,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        // 즉시 로컬 상태에 추가 (서버 재조회 전에 UI 반영)
        setWatchlist(prev => [...prev, {
          id: data.data?.id || `local-${Date.now()}`,
          stockCode: stock.displayCode,
          stockName: isOverseas ? `[미] ${stock.koreanName || stock.stockName}` : stock.stockName,
          sector: null,
          isActive: true,
        }]);
        await loadDashboardData();
      } else {
        console.error('관심종목 추가 실패:', data.error);
      }
    } catch (error) {
      console.error('관심종목 추가 실패:', error);
    }
  };

  // 관심종목 삭제
  const removeFromWatchlist = async (id: string) => {
    try {
      await fetch(`/api/watchlist?id=${id}`, { method: 'DELETE' });
      await loadDashboardData();
    } catch (error) {
      console.error('관심종목 삭제 실패:', error);
    }
  };

  // 관심종목에 이미 있는지 확인
  const isInWatchlist = (code: string) => {
    return watchlist.some(item => item.stockCode === code);
  };

  // 에이전트 상태 로드
  const loadAgentStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/status');
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setAgentStatus(data.data);
          setAgentLogs(data.data.recentLogs || []);
          setTradingStatus(data.data.isRunning ? 'RUNNING' : 'STOPPED');
          // 서버 스케줄러 상태 업데이트
          if (data.data.scheduler) {
            setSchedulerInfo(data.data.scheduler);
            setAgentMode(data.data.scheduler.schedulerMode as 'SERVER' | 'BROWSER');
          }
        }
      }
    } catch (error) {
      console.error('에이전트 상태 로드 실패:', error);
    }
  }, []);

  // localStorage에서 KIS 설정 로드 (서버 재시작해도 유지)
  const loadKisConfigFromStorage = useCallback(() => {
    try {
      const stored = localStorage.getItem('kis_config');
      if (stored) {
        const config = JSON.parse(stored);
        if (config.appKey && config.accountNo) {
          setKisConfigured(true);
          setSavedAppKeyMasked(config.appKey.substring(0, 8) + '****');
          setSavedAccountNo(config.accountNo);
          setSavedIsDemo(config.isDemo ?? true);
          setIsDemo(config.isDemo ?? true);
          setAccountNo(config.accountNo);
          return config; // 반환값 사용
        }
      }
    } catch (e) {
      console.warn('localStorage 로드 실패:', e);
    }
    setKisConfigured(false);
    return null;
  }, []);

  // KIS 설정 로드 (localStorage + 서버 동기화)
  // 핵심: 서버 설정이 있으면 localStorage 값을 절대 서버에 덮어쓰지 않음
  const loadKisConfig = useCallback(async () => {
    // 1. 먼저 localStorage에서 즉시 복원 (UI 깜빡임 방지용)
    const storedConfig = loadKisConfigFromStorage();

    // 2. 서버에서 확인 (서버가 진실의 원천)
    let hasServerConfig = false;

    try {
      const res = await fetch('/api/kis/config');
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data) {
          const configs = Array.isArray(data.data) ? data.data : [data.data];
          if (configs.length > 0) {
            const config = configs[0];
            hasServerConfig = true;
            setKisConfigured(true);
            setSavedAppKeyMasked(config.appKey || '');
            setSavedAccountNo(config.accountNo || '');
            setSavedIsDemo(config.isDemo ?? true);
            setIsDemo(config.isDemo ?? true);
            setAccountNo(config.accountNo || '');
            // return 하지 않음 — 토큰 상태도 항상 확인해야 함
          }
        }
      }

      // 3. 서버에 데이터가 없을 때만 localStorage → 서버 복원
      //    hasServerConfig가 true면 localStorage 값이 있어도 POST하지 않음
      if (!hasServerConfig && storedConfig) {
        console.log('[KIS Config] Restoring config to server from localStorage...');
        fetch('/api/kis/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appKey: storedConfig.appKey,
            appSecret: storedConfig.appSecret,
            accountNo: storedConfig.accountNo,
            isDemo: storedConfig.isDemo,
          }),
        }).catch(console.error);
      } else if (!hasServerConfig && !storedConfig) {
        // 둘 다 데이터 없음
        setKisConfigured(false);
      }

      // 토큰 상태도 확인
      try {
        const tokenRes = await fetch('/api/kis/token');
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          if (tokenData.success) {
            setKisHasToken(tokenData.data?.hasToken ?? false);
          }
        }
      } catch (tokenErr) {
        console.warn('[KIS Config] Token check failed:', tokenErr);
      }
    } catch (error) {
      console.error('KIS 설정 로드 실패:', error);
      // localStorage라도 있으면 configured 유지
      if (!storedConfig) setKisConfigured(false);
    }
  }, [loadKisConfigFromStorage]);

  // 초기 로드 및 자동 새로고침
  useEffect(() => {
    let mounted = true;
    const fetchData = async () => {
      if (!mounted) return;
      // 서버 DB에서 설정 먼저 로드 (진실의 원천)
      await loadSettingsFromServer();
      // KIS 설정/토큰 상태를 먼저 확인한 뒤 잔고 조회
      await loadKisConfig();
      await Promise.all([loadDashboardData(), loadOverseasData(), loadAgentStatus()]);
    };
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, [selectedStrategy, loadDashboardData, loadOverseasData, loadAgentStatus, loadKisConfig]);

  // 자동 사이클: 에이전트 실행 중 + 자동사이클 활성화 시 60초마다 실행
  useEffect(() => {
    if (!autoCycleEnabled || tradingStatus !== 'RUNNING') return;
    const cycleInterval = setInterval(async () => {
      try {
        setIsRunningCycle(true);
        await fetch('/api/agent/run', { method: 'POST' });
        await loadAgentStatus();
        await loadDashboardData();
      } catch (error) {
        console.error('자동 사이클 실행 실패:', error);
      } finally {
        setIsRunningCycle(false);
      }
    }, 60000); // 60초마다
    return () => clearInterval(cycleInterval);
  }, [autoCycleEnabled, tradingStatus, loadAgentStatus, loadDashboardData]);

  // 에이전트 시작
  const startTrading = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/agent/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: agentMode }),
      });
      const data = await res.json();
      if (data.success) {
        setTradingStatus('RUNNING');
        if (agentMode === 'BROWSER') {
          setAutoCycleEnabled(true);
        }
        await loadAgentStatus();
      }
    } catch (error) {
      console.error('에이전트 시작 실패:', error);
    }
    setIsLoading(false);
  };

  // 에이전트 중지
  const stopTrading = async () => {
    setIsLoading(true);
    setAutoCycleEnabled(false);
    try {
      const res = await fetch('/api/agent/stop', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setTradingStatus('STOPPED');
        await loadAgentStatus();
      }
    } catch (error) {
      console.error('에이전트 중지 실패:', error);
    }
    setIsLoading(false);
  };

  // 수동 1사이클 실행
  const runOneCycle = async () => {
    setIsRunningCycle(true);
    try {
      // 아직 시작 안했으면 먼저 시작
      if (tradingStatus !== 'RUNNING') {
        await startTrading();
      }
      const res = await fetch('/api/agent/run', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        await loadAgentStatus();
        await loadDashboardData();
      }
    } catch (error) {
      console.error('사이클 실행 실패:', error);
    }
    setIsRunningCycle(false);
  };

  // KIS 설정 저장
  const saveKisConfig = async () => {
    try {
      setKisTokenError('');
      // 수정 모드: appSecret이 빈칸이면 localStorage에서 기존 값 가져오기
      let finalAppSecret = appSecret;
      if (isEditMode && !appSecret) {
        try {
          const stored = localStorage.getItem('kis_config');
          if (stored) {
            finalAppSecret = JSON.parse(stored).appSecret || '';
          }
        } catch (e) {}
      }

      const res = await fetch('/api/kis/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey, appSecret: finalAppSecret, accountNo, isDemo }),
      });
      const data = await res.json();
      if (data.success) {
        // localStorage에도 저장 (서버 재시작 대비)
        localStorage.setItem('kis_config', JSON.stringify({
          appKey,
          appSecret: finalAppSecret,
          accountNo,
          isDemo,
        }));

        setKisConfigured(true);
        setIsEditMode(false);
        setSavedAppKeyMasked(appKey.substring(0, 8) + '****');
        setSavedAccountNo(accountNo);
        setSavedIsDemo(isDemo);
        // 입력 필드 초기화
        setAppKey('');
        setAppSecret('');

        // 토큰 발급 시도
        setKisTokenLoading(true);
        try {
          const tokenRes = await fetch('/api/kis/token', { method: 'POST' });
          const tokenData = await tokenRes.json();
          if (tokenData.success) {
            setKisHasToken(true);
            setKisTokenError('');
            setTokenCooldown(10); // 성공 시 10초 쿨다운
          } else {
            setKisHasToken(false);
            setKisTokenError(tokenData.error || '토큰 발급 실패');
            setTokenCooldown(60); // 실패 시 60초 쿨다운
          }
        } catch (tokenErr: any) {
          setKisHasToken(false);
          setKisTokenError(tokenErr.message || '토큰 발급 중 네트워크 오류');
          setTokenCooldown(60); // 에러 시 60초 쿨다운
        } finally {
          setKisTokenLoading(false);
        }
      }
    } catch (error) {
      console.error('KIS 설정 실패:', error);
    }
  };

  // 토큰 재발급 쿨다운 타이머
  useEffect(() => {
    if (tokenCooldown <= 0) return;
    const timer = setInterval(() => {
      setTokenCooldown(prev => {
        if (prev <= 1) return 0;
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [tokenCooldown]);

  // 토큰 재발급
  const reissueToken = async () => {
    if (tokenCooldown > 0 || kisTokenLoading) return; // 쿨다운 중이거나 이미 발급 중이면 무시
    setKisTokenLoading(true);
    setKisTokenError('');
    try {
      // 서버에 설정이 없으면 localStorage에서 복원 후 시도
      const configRes = await fetch('/api/kis/config');
      const configData = await configRes.json();
      const hasServerConfig = configData.success && configData.data && 
        (Array.isArray(configData.data) ? configData.data.length > 0 : !!configData.data);
      
      if (!hasServerConfig) {
        const stored = localStorage.getItem('kis_config');
        if (stored) {
          const config = JSON.parse(stored);
          await fetch('/api/kis/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
          });
        }
      }

      const tokenRes = await fetch('/api/kis/token', { method: 'POST' });
      const tokenData = await tokenRes.json();
      if (tokenData.success) {
        setKisHasToken(true);
        setKisTokenError('');
        // 성공 시 10초 쿨다운
        setTokenCooldown(10);
      } else {
        setKisHasToken(false);
        setKisTokenError(tokenData.error || '토큰 발급 실패');
        // 실패 시 60초 쿨다운 (KIS 속도제한: 1분당 1회)
        setTokenCooldown(60);
      }
    } catch (err: any) {
      setKisHasToken(false);
      setKisTokenError(err.message || '토큰 발급 중 오류');
      // 에러 시 60초 쿨다운
      setTokenCooldown(60);
    } finally {
      setKisTokenLoading(false);
    }
  };

  // 분석 새로고침
  const refreshSignals = async () => {
    setIsLoading(true);
    await loadDashboardData();
    setIsLoading(false);
  };

  // 오늘 수익률
  const todayProfitRate = accountBalance > 0 ? ((todayProfit / accountBalance) * 100).toFixed(2) : '0';

  // 활성 매수/매도 신호 수
  const buySignals = signals.filter(s => s.signalType === 'BUY');
  const sellSignals = signals.filter(s => s.signalType === 'SELL');

  return (
    <div className="min-h-screen bg-background">
      {/* 헤더 */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600">
              <Bot className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">AI Trading Agent</h1>
              <p className="text-xs text-muted-foreground">한국투자증권 자동매매 시스템</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* 매매 상태 */}
            <div className="flex items-center gap-2 rounded-full border px-3 py-1.5">
              <div className={`h-2 w-2 rounded-full ${tradingStatus === 'RUNNING' ? 'bg-emerald-500 animate-pulse' : tradingStatus === 'PAUSED' ? 'bg-amber-500' : 'bg-gray-400'}`} />
              <span className="text-sm font-medium">
                {tradingStatus === 'RUNNING' ? '실행 중' : tradingStatus === 'PAUSED' ? '일시정지' : '대기'}
              </span>
            </div>

            {/* 제어 버튼 */}
            <div className="flex items-center gap-1">
              {tradingStatus !== 'RUNNING' ? (
                <Button 
                  size="sm" 
                  onClick={startTrading} 
                  disabled={isLoading}
                  className="bg-emerald-600 hover:bg-emerald-700"
                >
                  <Play className="h-4 w-4 mr-1" />
                  시작
                </Button>
              ) : (
                <>
                  <Button 
                    size="sm" 
                    variant="outline" 
                    onClick={() => setTradingStatus('PAUSED')}
                  >
                    <Pause className="h-4 w-4 mr-1" />
                    일시정지
                  </Button>
                  <Button 
                    size="sm" 
                    variant="destructive" 
                    onClick={stopTrading}
                    disabled={isLoading}
                  >
                    <Square className="h-4 w-4 mr-1" />
                    중지
                  </Button>
                </>
              )}
            </div>

            <Button size="sm" variant="outline" onClick={refreshSignals} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
              새로고침
            </Button>

            <Dialog open={showKisDialog} onOpenChange={(open) => {
              setShowKisDialog(open);
              if (open && kisConfigured) {
                // 이미 설정된 경우: 수정 모드 아님 (읽기 전용)
                setIsEditMode(false);
              } else if (open && !kisConfigured) {
                // 설정 없음: 바로 입력 모드
                setIsEditMode(true);
              }
              if (!open) {
                setIsEditMode(false);
              }
            }}>
              <DialogTrigger asChild>
                <Button size="sm" variant={kisConfigured ? "secondary" : "outline"}>
                  <Settings className="h-4 w-4 mr-1" />
                  API 설정
                  {kisConfigured && (
                    <span className="ml-1.5 flex h-2 w-2 rounded-full bg-green-500" />
                  )}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>한국투자증권 API 설정</DialogTitle>
                  <DialogDescription>
                    {kisConfigured
                      ? 'API 설정이 등록되어 있습니다. 수정하려면 수정 버튼을 클릭하세요.'
                      : 'KIS Developers에서 발급받은 App Key와 App Secret을 입력하세요.'}
                  </DialogDescription>
                </DialogHeader>

                {kisConfigured && !isEditMode ? (
                  /* ===== 저장된 설정 보기 모드 ===== */
                  <div className="space-y-4 py-4">
                    <div className="rounded-lg border p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-muted-foreground">연결 상태</span>
                        <div className="flex items-center gap-2">
                          <span className="flex h-2.5 w-2.5 rounded-full bg-green-500" />
                          <span className="text-sm font-medium text-green-600">연결됨</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-muted-foreground">모드</span>
                        <Badge variant={savedIsDemo ? "secondary" : "destructive"}>
                          {savedIsDemo ? '모의투자' : '실전투자'}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-muted-foreground">App Key</span>
                        <span className="text-sm font-mono">{savedAppKeyMasked}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-muted-foreground">계좌번호</span>
                        <span className="text-sm font-mono">{savedAccountNo}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-muted-foreground">토큰</span>
                        <div className="flex items-center gap-2">
                          {kisTokenLoading ? (
                            <Badge variant="outline"><RefreshCw className="h-3 w-3 mr-1 animate-spin" />발급 중...</Badge>
                          ) : (
                            <Badge variant={kisHasToken ? "default" : "outline"}>
                              {kisHasToken ? '발급됨' : '미발급'}
                            </Badge>
                          )}
                          {!kisHasToken && !kisTokenLoading && (
                            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={reissueToken} disabled={tokenCooldown > 0}>
                              {tokenCooldown > 0 ? `${tokenCooldown}초 후 재시도` : '재발급'}
                            </Button>
                          )}
                        </div>
                      </div>
                      {kisTokenError && (
                        <div className="rounded-md bg-red-50 border border-red-200 p-2 mt-2">
                          <p className="text-xs text-red-600 font-medium">토큰 발급 실패</p>
                          <p className="text-xs text-red-500 mt-0.5">{kisTokenError}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            App Key/Secret이 정확한지, 모의투자 모드 설정이 맞는지 확인하세요.
                          </p>
                        </div>
                      )}
                    </div>
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        App Secret은 보안상 표시되지 않습니다. 수정 시 새로 입력해주세요.
                      </AlertDescription>
                    </Alert>
                  </div>
                ) : (
                  /* ===== 입력/수정 모드 ===== */
                  <div className="space-y-4 py-4">
                    <div className="flex items-center gap-2">
                      <Switch checked={isDemo} onCheckedChange={setIsDemo} />
                      <Label>모의투자 모드</Label>
                      {isDemo ? (
                        <Badge variant="secondary" className="ml-2">모의투자</Badge>
                      ) : (
                        <Badge variant="destructive" className="ml-2">실전투자</Badge>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label>App Key</Label>
                      <Input 
                        placeholder="PSxxx..." 
                        value={appKey} 
                        onChange={(e) => setAppKey(e.target.value)} 
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>App Secret</Label>
                      <Input 
                        placeholder={isEditMode ? "변경하려면 입력하세요 (빈칸则 유지)" : "xxxxxxxx"}
                        type="password" 
                        value={appSecret} 
                        onChange={(e) => setAppSecret(e.target.value)} 
                      />
                      {isEditMode && (
                        <p className="text-xs text-muted-foreground">변경하지 않으려면 빈칸으로 두세요.</p>
                      )}
                    </div>
                    <div className="space-y-2">
                      <Label>계좌번호</Label>
                      <Input 
                        placeholder="50123456-01" 
                        value={accountNo} 
                        onChange={(e) => setAccountNo(e.target.value)} 
                      />
                    </div>
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertDescription>
                        API 키는 안전하게 저장되며, 모의투자 모드에서 먼저 테스트하는 것을 권장합니다.
                      </AlertDescription>
                    </Alert>
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  {kisConfigured && !isEditMode ? (
                    <>
                      <Button variant="outline" onClick={() => setShowKisDialog(false)}>닫기</Button>
                      <Button variant="destructive" onClick={async () => {
                        if (confirm('정말 삭제하시겠습니까? API 연결이 해제됩니다.')) {
                          try {
                            await fetch('/api/kis/config', { method: 'DELETE' });
                          } catch (e) {
                            console.error('삭제 실패:', e);
                          }
                          // localStorage도 삭제
                          localStorage.removeItem('kis_config');
                          setKisConfigured(false);
                          setKisHasToken(false);
                          setSavedAppKeyMasked('');
                          setSavedAccountNo('');
                          setSavedIsDemo(true);
                          setAppKey('');
                          setAppSecret('');
                          setAccountNo('');
                          setIsDemo(true);
                          setIsEditMode(true);
                        }
                      }}>삭제</Button>
                      <Button onClick={() => {
                        setIsEditMode(true);
                        setAppKey('');
                        setAppSecret('');
                      }}>수정</Button>
                    </>
                  ) : (
                    <>
                      {isEditMode && kisConfigured && (
                        <Button variant="outline" onClick={() => {
                          setIsEditMode(false);
                          setAppKey('');
                          setAppSecret('');
                        }}>취소</Button>
                      )}
                      <Button variant="outline" onClick={() => setShowKisDialog(false)}>닫기</Button>
                      <Button onClick={saveKisConfig} disabled={!appKey || !accountNo}>
                        {isEditMode && kisConfigured ? '업데이트' : '저장'}
                      </Button>
                    </>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      {/* 메인 컨텐츠 */}
      <main className="container px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-7">
            <TabsTrigger value="dashboard"><Activity className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">대시보드</span></TabsTrigger>
            <TabsTrigger value="agent"><Bot className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">에이전트</span></TabsTrigger>
            <TabsTrigger value="signals"><Zap className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">매매신호</span></TabsTrigger>
            <TabsTrigger value="watchlist"><Star className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">관심종목</span></TabsTrigger>
            <TabsTrigger value="overseas"><Globe className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">해외주식</span></TabsTrigger>
            <TabsTrigger value="strategy"><BarChart3 className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">전략</span></TabsTrigger>
            <TabsTrigger value="risk"><Shield className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">리스크</span></TabsTrigger>
          </TabsList>

          {/* ===== 대시보드 탭 ===== */}
          <TabsContent value="dashboard" className="space-y-6">
            {/* KIS 연결 에러 표시 — 실패 사유를 명확히 보여줌 */}
            {kisConnectionError && (
              <Alert className="border-red-200 bg-red-50">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <AlertDescription className="text-red-800">
                  <strong>KIS 연결 실패</strong> — {kisConnectionError}
                </AlertDescription>
              </Alert>
            )}
            {/* KIS 미설정 안내 (설정 자체가 없는 경우) */}
            {dataSource === 'mock' && !kisConfigured && !kisConnectionError && (
              <Alert className="border-amber-200 bg-amber-50">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-800">
                  <strong>KIS API 미설정</strong> — App Key, App Secret, 계좌번호를 먼저 저장해주세요. 
                  API 설정을 완료하면 실제 모의투자 잔고와 거래가 연동됩니다.
                </AlertDescription>
              </Alert>
            )}
            {/* KIS 설정은 있으나 토큰 미발급 안내 */}
            {dataSource === 'mock' && kisConfigured && !kisHasToken && !kisConnectionError && (
              <Alert className="border-amber-200 bg-amber-50">
                <AlertTriangle className="h-4 w-4 text-amber-600" />
                <AlertDescription className="text-amber-800">
                  <strong>KIS 토큰 미발급</strong> — API 설정은 있으나 토큰이 발급되지 않았습니다. 
                  잔고 조회 시 자동 발급을 시도합니다. 계속 안 되면 API 설정에서 토큰을 수동 발급받으세요.
                </AlertDescription>
              </Alert>
            )}
            {/* 에이전트 미실행 안내 */}
            {tradingStatus !== 'RUNNING' && (
              <Alert className="border-blue-200 bg-blue-50">
                <Bot className="h-4 w-4 text-blue-600" />
                <AlertDescription className="text-blue-800">
                  <strong>에이전트 대기 중</strong> — 자동매매를 시작하려면 상단의 <strong>시작</strong> 버튼을 클릭하세요. 
                  에이전트가 실행되면 관심종목을 분석하여 매매 신호를 생성하고 주문을 실행합니다.
                </AlertDescription>
              </Alert>
            )}
            {/* 요약 카드 */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm font-medium">총 자산</CardTitle>
                    <Badge variant={dataSource === 'api' ? "default" : "outline"} className="text-[10px] px-1.5 py-0 h-4">
                      {dataSource === 'api' ? '실시간' : '모의데이터'}
                    </Badge>
                  </div>
                  <Coins className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {dataSource === 'mock' && accountBalance === 0 ? '—' : `${formatFullMoney(accountBalance + todayProfit)}원`}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {dataSource === 'api' ? `예수금: ${formatMoney(accountBalance)}원` : 'KIS API 연결 시 표시됩니다'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">오늘 수익</CardTitle>
                  {todayProfit >= 0 ? <ArrowUpRight className="h-4 w-4 text-emerald-500" /> : <ArrowDownRight className="h-4 w-4 text-red-500" />}
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${dataSource === 'mock' ? 'text-muted-foreground' : todayProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {dataSource === 'mock' ? '—' : `${todayProfit >= 0 ? '+' : ''}${formatFullMoney(todayProfit)}원`}
                  </div>
                  <p className={`text-xs ${todayProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {todayProfit >= 0 ? '+' : ''}{todayProfitRate}%
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">매수 신호</CardTitle>
                  <TrendingUp className="h-4 w-4 text-emerald-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-emerald-600">{buySignals.length}</div>
                  <p className="text-xs text-muted-foreground">
                    매도 {sellSignals.length} | 관망 {signals.filter(s => s.signalType === 'HOLD').length}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">총 수익률</CardTitle>
                  <LineChart className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${dataSource === 'mock' ? 'text-muted-foreground' : totalProfitRate >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {dataSource === 'mock' ? '—' : `${totalProfitRate >= 0 ? '+' : ''}${totalProfitRate.toFixed(1)}%`}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {dataSource === 'api' ? `보유 포지션 ${positions.length}개` : 'KIS API 연결 시 표시됩니다'}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* AI 신호 분석 & 포지션 */}
            <div className="grid gap-6 lg:grid-cols-2">
              {/* 실시간 매매 신호 */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">AI 매매 신호</CardTitle>
                      <CardDescription>5대 전략 종합 분석 결과</CardDescription>
                    </div>
                    <Select value={selectedStrategy} onValueChange={setSelectedStrategy}>
                      <SelectTrigger className="w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="ALL">전체 전략</SelectItem>
                        <SelectItem value="COMPOSITE">복합 지표</SelectItem>
                        <SelectItem value="SUPER_TREND">SuperTrend</SelectItem>
                        <SelectItem value="VOLATILITY_BREAKOUT">변동성 돌파</SelectItem>
                        <SelectItem value="MEAN_REVERSION">평균 회귀</SelectItem>
                        <SelectItem value="MOMENTUM">모멘텀</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px]">
                    <div className="space-y-3">
                      {signals.map((signal, index) => (
                        <div 
                          key={`${signal.stockCode}-${index}`}
                          className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50 transition-colors"
                        >
                          <div className="flex items-center gap-3">
                            <SignalBadge type={signal.signalType} />
                            <div>
                              <div className="font-medium text-sm">{signal.stockName}</div>
                              <div className="text-xs text-muted-foreground">{signal.stockCode}</div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-medium">{formatFullMoney(signal.price)}원</div>
                            <div className="flex items-center gap-1">
                              <Progress value={signal.confidence} className="h-1.5 w-16" />
                              <span className="text-xs text-muted-foreground">{signal.confidence}%</span>
                            </div>
                          </div>
                        </div>
                      ))}
                      {signals.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                          <Activity className="h-12 w-12 mb-3 opacity-20" />
                          <p className="text-sm">신호를 불러오는 중...</p>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </CardContent>
              </Card>

              {/* 보유 포지션 */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">보유 포지션</CardTitle>
                  <CardDescription>현재 보유 중인 주식 현황</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[400px]">
                    {positions.length > 0 ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>종목</TableHead>
                            <TableHead className="text-right">수량</TableHead>
                            <TableHead className="text-right">평가금</TableHead>
                            <TableHead className="text-right">수익률</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {positions.map((pos) => (
                            <TableRow key={pos.stockCode}>
                              <TableCell>
                                <div className="font-medium">{pos.stockName}</div>
                                <div className="text-xs text-muted-foreground">{pos.stockCode}</div>
                              </TableCell>
                              <TableCell className="text-right">{pos.quantity}주</TableCell>
                              <TableCell className="text-right">{formatMoney(pos.evaluationAmount)}원</TableCell>
                              <TableCell className="text-right">
                                <span className={pos.profitRate >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                                  {pos.profitRate >= 0 ? '+' : ''}{pos.profitRate.toFixed(1)}%
                                </span>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                        <Wallet className="h-12 w-12 mb-3 opacity-20" />
                        <p className="text-sm">보유 포지션이 없습니다</p>
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>

            {/* 최근 거래 내역 */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">최근 거래 내역</CardTitle>
                    <CardDescription>자동매매 실행 기록</CardDescription>
                  </div>
                  <Badge variant="outline">{trades.length}건</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[300px]">
                  {trades.length > 0 ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>시간</TableHead>
                          <TableHead>종목</TableHead>
                          <TableHead>구분</TableHead>
                          <TableHead>수량</TableHead>
                          <TableHead>가격</TableHead>
                          <TableHead>출처</TableHead>
                          <TableHead>전략</TableHead>
                          <TableHead>상태</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {trades.map((trade) => {
                          const isOverseas = trade.currency === 'USD' || trade.market === 'OVERSEAS';
                          const displayPrice = trade.filledPrice ?? trade.orderPrice ?? trade.price;
                          const currencySymbol = isOverseas ? '$' : '원';
                          const formatPrice = isOverseas
                            ? `$${displayPrice.toFixed(2)}`
                            : `${formatFullMoney(displayPrice)}원`;
                          return (
                          <TableRow key={trade.id}>
                            <TableCell className="text-xs">
                              {new Date(trade.tradedAt).toLocaleString('ko-KR')}
                            </TableCell>
                            <TableCell>
                              <div className="font-medium">{trade.stockName}</div>
                              {isOverseas && trade.exchangeCode && (
                                <div className="text-xs text-muted-foreground">{trade.exchangeCode}</div>
                              )}
                            </TableCell>
                            <TableCell>
                              <SignalBadge type={trade.tradeType} />
                            </TableCell>
                            <TableCell>{trade.quantity}주</TableCell>
                            <TableCell>
                              <div>{formatPrice}</div>
                              {trade.slippagePercent != null && Math.abs(trade.slippagePercent) > 0.01 && (
                                <div className={`text-xs ${trade.slippagePercent > 0 ? 'text-red-500' : 'text-emerald-500'}`}>
                                  슬리피지 {trade.slippagePercent > 0 ? '+' : ''}{trade.slippagePercent.toFixed(2)}%
                                </div>
                              )}
                            </TableCell>
                            <TableCell>
                              <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                                trade.orderExecutionMode === 'DRY_RUN' ? 'bg-gray-100 text-gray-600'
                                : trade.orderExecutionMode === 'PAPER' ? 'bg-blue-50 text-blue-600'
                                : trade.orderExecutionMode === 'LIVE' ? 'bg-red-50 text-red-600'
                                : 'bg-gray-100 text-gray-600'
                              }`}>
                                {trade.source === 'MANUAL' ? '수동' : trade.source === 'TEST' ? '테스트' : '에이전트'}
                              </span>
                              <span className={`ml-1 inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${
                                trade.orderExecutionMode === 'DRY_RUN' ? 'bg-gray-100 text-gray-500'
                                : trade.orderExecutionMode === 'PAPER' ? 'bg-blue-50 text-blue-500'
                                : trade.orderExecutionMode === 'LIVE' ? 'bg-red-50 text-red-500'
                                : 'bg-gray-100 text-gray-500'
                              }`}>
                                {trade.orderExecutionMode || 'DRY_RUN'}
                              </span>
                            </TableCell>
                            <TableCell>
                              <StrategyTypeBadge type={trade.strategy} />
                            </TableCell>
                            <TableCell>
                              {trade.status === 'FILLED' ? (
                                <CheckCircle className="h-4 w-4 text-emerald-500" />
                              ) : trade.status === 'PENDING' ? (
                                <Clock className="h-4 w-4 text-amber-500" />
                              ) : (
                                <XCircle className="h-4 w-4 text-red-500" />
                              )}
                            </TableCell>
                          </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <Clock className="h-12 w-12 mb-3 opacity-20" />
                      <p className="text-sm">거래 내역이 없습니다</p>
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 매매신호 탭 ===== */}
          <TabsContent value="signals" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">AI 매매 신호 분석</h2>
                <p className="text-sm text-muted-foreground">
                  5대 전략 종합 분석으로 도출된 매수/매도 타점
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Select value={selectedStrategy} onValueChange={setSelectedStrategy}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">종합 전략 (가중평균)</SelectItem>
                    <SelectItem value="COMPOSITE">복합 지표 (4중검증)</SelectItem>
                    <SelectItem value="SUPER_TREND">SuperTrend 추세추종</SelectItem>
                    <SelectItem value="VOLATILITY_BREAKOUT">변동성 돌파</SelectItem>
                    <SelectItem value="MEAN_REVERSION">평균 회귀</SelectItem>
                    <SelectItem value="MOMENTUM">모멘텀</SelectItem>
                  </SelectContent>
                </Select>
                <Button onClick={refreshSignals} disabled={isLoading}>
                  <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
                  분석실행
                </Button>
              </div>
            </div>

            {/* 신호 요약 */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-800">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-emerald-100 p-3 dark:bg-emerald-900">
                      <TrendingUp className="h-6 w-6 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm text-emerald-600">매수 신호</p>
                      <p className="text-3xl font-bold text-emerald-700">{buySignals.length}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-800">
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-red-100 p-3 dark:bg-red-900">
                      <TrendingDown className="h-6 w-6 text-red-600" />
                    </div>
                    <div>
                      <p className="text-sm text-red-600">매도 신호</p>
                      <p className="text-3xl font-bold text-red-700">{sellSignals.length}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-gray-100 p-3 dark:bg-gray-800">
                      <Eye className="h-6 w-6 text-gray-600" />
                    </div>
                    <div>
                      <p className="text-sm text-gray-600">관망</p>
                      <p className="text-3xl font-bold">{signals.filter(s => s.signalType === 'HOLD').length}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* 상세 신호 리스트 */}
            <Card>
              <CardHeader>
                <CardTitle>종목별 상세 신호</CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[600px]">
                  <div className="space-y-4">
                    {signals.map((signal, index) => (
                      <div 
                        key={`detail-${signal.stockCode}-${index}`}
                        className={`rounded-lg border p-4 ${
                          signal.signalType === 'BUY' ? 'border-emerald-200 bg-emerald-50/30 dark:border-emerald-800 dark:bg-emerald-950/10' :
                          signal.signalType === 'SELL' ? 'border-red-200 bg-red-50/30 dark:border-red-800 dark:bg-red-950/10' :
                          ''
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            <SignalBadge type={signal.signalType} />
                            <div>
                              <h3 className="font-semibold">{signal.stockName}</h3>
                              <p className="text-sm text-muted-foreground">{signal.stockCode}</p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="font-semibold">{formatFullMoney(signal.price)}원</p>
                            <div className="flex items-center gap-2 justify-end">
                              <Progress value={signal.confidence} className="h-2 w-24" />
                              <span className="text-sm font-medium">신뢰도 {signal.confidence}%</span>
                            </div>
                          </div>
                        </div>
                        
                        <Separator className="my-3" />
                        
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <StrategyTypeBadge type={signal.strategy} />
                            <span className="text-sm text-muted-foreground">{signal.reason}</span>
                          </div>
                          
                          {Object.keys(signal.indicators).length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-2">
                              {Object.entries(signal.indicators).map(([key, value]) => (
                                <Badge key={key} variant="outline" className="text-xs">
                                  {key}: {typeof value === 'number' ? value.toFixed(1) : value}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 관심종목 탭 ===== */}
          <TabsContent value="watchlist" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">관심종목 관리</h2>
                <p className="text-sm text-muted-foreground">
                  종목을 검색하여 관심종목에 추가하고 AI 매매 신호를 받으세요
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Dialog open={showSearchDialog} onOpenChange={setShowSearchDialog}>
                  <DialogTrigger asChild>
                    <Button className="bg-emerald-600 hover:bg-emerald-700">
                      <Search className="h-4 w-4 mr-2" />
                      종목 검색 추가
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[540px]">
                    <DialogHeader>
                      <DialogTitle>종목 검색</DialogTitle>
                      <DialogDescription>
                        종목명 또는 종목코드로 검색하여 관심종목에 추가하세요
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input 
                          placeholder="종목명 또는 종목코드 입력 (예: 삼성전자, 005930, 반도체)"
                          value={searchQuery}
                          onChange={(e) => {
                            setSearchQuery(e.target.value);
                            searchStocks(e.target.value);
                          }}
                          className="pl-9"
                          autoFocus
                        />
                        {isSearching && <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
                      </div>
                      
                      {/* 검색 결과 */}
                      <ScrollArea className="h-[350px]">
                        {searchResults.length > 0 ? (
                          <div className="space-y-1">
                            {searchResults.map((stock) => {
                              const alreadyAdded = isInWatchlist(stock.displayCode);
                              return (
                                <div 
                                  key={stock.displayCode}
                                  className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50 transition-colors"
                                >
                                  <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                                      <span className="text-xs font-bold text-muted-foreground">{stock.symbol.slice(-4)}</span>
                                    </div>
                                    <div>
                                      <div className="font-medium">{stock.stockName}</div>
                                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                        <span className="font-mono">{stock.displayCode}</span>
                                        <Badge variant="outline" className="text-xs py-0">{stock.currency}</Badge>
                                      </div>
                                    </div>
                                  </div>
                                  <Button 
                                    size="sm" 
                                    variant={alreadyAdded ? "secondary" : "default"}
                                    disabled={alreadyAdded}
                                    onClick={() => addToWatchlist(stock)}
                                    className={alreadyAdded ? '' : 'bg-emerald-600 hover:bg-emerald-700'}
                                  >
                                    {alreadyAdded ? (
                                      <>
                                        <CheckCircle className="h-4 w-4 mr-1" />
                                        추가됨
                                      </>
                                    ) : (
                                      <>
                                        <Plus className="h-4 w-4 mr-1" />
                                        추가
                                      </>
                                    )}
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        ) : searchQuery.length > 0 ? (
                          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                            <Search className="h-12 w-12 mb-3 opacity-20" />
                            <p className="text-sm">검색 결과가 없습니다</p>
                            <p className="text-xs mt-1">다른 검색어로 시도해보세요</p>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                            <Search className="h-12 w-12 mb-3 opacity-20" />
                            <p className="text-sm">종목명, 종목코드로 검색</p>
                            <div className="flex flex-wrap gap-2 mt-4 max-w-[400px] justify-center">
                              {['삼성', '반도체', '2차전지', '카카오', '005930', 'ETF', '방산', '바이오'].map(keyword => (
                                <Button 
                                  key={keyword}
                                  size="sm" 
                                  variant="outline"
                                  onClick={() => {
                                    setSearchQuery(keyword);
                                    searchStocks(keyword);
                                  }}
                                  className="text-xs"
                                >
                                  {keyword}
                                </Button>
                              ))}
                            </div>
                          </div>
                        )}
                      </ScrollArea>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>

            {/* 관심종목 통계 */}
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-amber-100 p-3 dark:bg-amber-900">
                      <Star className="h-6 w-6 text-amber-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">관심종목 수</p>
                      <p className="text-2xl font-bold">{watchlist.length}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-emerald-100 p-3 dark:bg-emerald-900">
                      <TrendingUp className="h-6 w-6 text-emerald-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">매수 신호 종목</p>
                      <p className="text-2xl font-bold text-emerald-600">
                        {signals.filter(s => s.signalType === 'BUY' && watchlist.some(w => w.stockCode === s.stockCode)).length}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-violet-100 p-3 dark:bg-violet-900">
                      <Activity className="h-6 w-6 text-violet-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">섹터 수</p>
                      <p className="text-2xl font-bold">
                        {new Set(watchlist.map(w => w.sector).filter(Boolean)).size}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* 관심종목 리스트 */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">관심종목 목록</CardTitle>
                    <CardDescription>AI 분석 대상 종목 — 관심종목에 추가된 종목만 자동매매 분석에 포함됩니다</CardDescription>
                  </div>
                  <Badge variant="outline">{watchlist.length}종목</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {watchlist.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>종목코드</TableHead>
                        <TableHead>종목명</TableHead>
                        <TableHead>섹터</TableHead>
                        <TableHead className="text-center">AI 신호</TableHead>
                        <TableHead className="text-right">관리</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {watchlist.map((item) => {
                        const signal = signals.find(s => s.stockCode === item.stockCode);
                        return (
                          <TableRow key={item.id}>
                            <TableCell className="font-mono text-sm">{item.stockCode}</TableCell>
                            <TableCell className="font-medium">{item.stockName}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">{item.sector || '-'}</Badge>
                            </TableCell>
                            <TableCell className="text-center">
                              {signal ? (
                                <SignalBadge type={signal.signalType} />
                              ) : (
                                <Badge variant="secondary" className="text-xs">분석 대기</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button 
                                size="sm" 
                                variant="ghost" 
                                className="text-red-500 hover:text-red-700 hover:bg-red-50"
                                onClick={() => removeFromWatchlist(item.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                    <Star className="h-12 w-12 mb-3 opacity-20" />
                    <p className="text-sm">관심종목이 없습니다</p>
                    <p className="text-xs mt-1">위의 "종목 검색 추가" 버튼으로 종목을 추가하세요</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 섹터별 분포 */}
            {watchlist.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">섹터별 분포</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-3">
                    {Object.entries(
                      watchlist.reduce((acc, item) => {
                        const sector = item.sector || '기타';
                        acc[sector] = (acc[sector] || 0) + 1;
                        return acc;
                      }, {} as Record<string, number>)
                    ).sort((a, b) => b[1] - a[1]).map(([sector, count]) => (
                      <div key={sector} className="flex items-center gap-2 rounded-lg border px-3 py-2">
                        <Badge variant="outline">{sector}</Badge>
                        <span className="text-sm font-medium">{count}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ===== 해외주식 탭 ===== */}
          <TabsContent value="overseas" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">해외주식 (미국)</h2>
                <p className="text-sm text-muted-foreground">
                  미국 나스닥/뉴욕거래소 종목 AI 매매 신호 및 포지션 관리
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Dialog open={showOverseasSearchDialog} onOpenChange={setShowOverseasSearchDialog}>
                  <DialogTrigger asChild>
                    <Button className="bg-blue-600 hover:bg-blue-700">
                      <Search className="h-4 w-4 mr-2" />
                      미국종목 검색
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-[540px]">
                    <DialogHeader>
                      <DialogTitle>미국 종목 검색</DialogTitle>
                      <DialogDescription>
                        티커 또는 종목명으로 검색하여 관심종목에 추가하세요
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-2">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                        <Input
                          placeholder="티커 또는 종목명 (예: AAPL, 애플, NVIDIA, 반도체)"
                          value={overseasSearchQuery}
                          onChange={(e) => {
                            setOverseasSearchQuery(e.target.value);
                            searchOverseasStocks(e.target.value);
                          }}
                          className="pl-9"
                          autoFocus
                        />
                        {isOverseasSearching && <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
                      </div>

                      <ScrollArea className="h-[350px]">
                        {overseasSearchResults.length > 0 ? (
                          <div className="space-y-1">
                            {overseasSearchResults.map((stock) => (
                              <div
                                key={stock.displayCode}
                                className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/50 transition-colors"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950">
                                    <span className="text-xs font-bold text-blue-600">{stock.symbol.slice(0, 2)}</span>
                                  </div>
                                  <div>
                                    <div className="font-medium">{stock.koreanName || stock.stockName}</div>
                                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                      <span className="font-mono">{stock.displayCode}</span>
                                      {stock.englishName && <Badge variant="outline" className="text-xs py-0">{stock.englishName}</Badge>}
                                      <Badge variant="outline" className="text-xs py-0 text-blue-600">{stock.currency}</Badge>
                                    </div>
                                  </div>
                                </div>
                                <Button
                                  size="sm"
                                  variant="default"
                                  className="bg-blue-600 hover:bg-blue-700"
                                  onClick={() => addToWatchlist(stock)}
                                >
                                  <Plus className="h-3 w-3 mr-1" />
                                  추가
                                </Button>
                              </div>
                            ))}
                          </div>
                        ) : overseasSearchQuery ? (
                          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                            <Search className="h-12 w-12 mb-3 opacity-20" />
                            <p className="text-sm">검색 결과가 없습니다</p>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                            <Globe className="h-12 w-12 mb-3 opacity-20" />
                            <p className="text-sm">티커 또는 종목명을 입력하세요</p>
                            <div className="mt-3 flex flex-wrap gap-2 justify-center">
                              {['AAPL', 'NVDA', 'TSLA', 'MSFT', 'GOOGL', 'AMZN'].map(ticker => (
                                <Button
                                  key={ticker}
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setOverseasSearchQuery(ticker);
                                    searchOverseasStocks(ticker);
                                  }}
                                >
                                  {ticker}
                                </Button>
                              ))}
                            </div>
                          </div>
                        )}
                      </ScrollArea>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
            </div>

            {/* 해외주식 요약 카드 */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">해외 예수금</CardTitle>
                  <Coins className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {dataSource === 'mock' && overseasBalance === 0 ? '—' : `${formatMoney(overseasBalance)}원`}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {dataSource === 'api' ? `출금가능: ${formatMoney(overseasAvailable)}원` : 'KIS API 연결 시 표시됩니다'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">해외 수익률</CardTitle>
                  <LineChart className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${dataSource === 'mock' ? 'text-muted-foreground' : overseasProfitRate >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {dataSource === 'mock' ? '—' : `${overseasProfitRate >= 0 ? '+' : ''}${overseasProfitRate.toFixed(1)}%`}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {dataSource === 'api' ? '환율: 1,330 KRW/USD' : 'KIS API 연결 시 표시됩니다'}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">보유 종목</CardTitle>
                  <Globe className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{overseasPositions.length}개</div>
                  <p className="text-xs text-muted-foreground">
                    나스닥/뉴욕/아멕스
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">해외 평가금액</CardTitle>
                  <Wallet className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {formatMoney(overseasPositions.reduce((sum, p) => sum + p.evaluationAmount, 0))}원
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {formatMoney(overseasPositions.reduce((sum, p) => sum + p.foreignEvaluation, 0))} USD
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* 해외주식 포지션 테이블 */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">미국 주식 포지션</CardTitle>
                    <CardDescription>나스닥/뉴욕/아멕스 보유 종목</CardDescription>
                  </div>
                  <Button size="sm" variant="outline" onClick={async () => { await loadOverseasData(); }}>
                    <RefreshCw className="h-3 w-3 mr-1" />
                    새로고침
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[400px]">
                  {overseasPositions.length > 0 ? (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>종목</TableHead>
                          <TableHead>거래소</TableHead>
                          <TableHead className="text-right">수량</TableHead>
                          <TableHead className="text-right">평균단가</TableHead>
                          <TableHead className="text-right">현재가</TableHead>
                          <TableHead className="text-right">평가금액</TableHead>
                          <TableHead className="text-right">수익률</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {overseasPositions.map((pos) => (
                          <TableRow key={`${pos.stockCode}-${pos.exchangeCode}`}>
                            <TableCell>
                              <div className="font-medium">{pos.stockName}</div>
                              <div className="text-xs text-muted-foreground font-mono">{pos.stockCode}</div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs text-blue-600">{pos.exchangeName}</Badge>
                            </TableCell>
                            <TableCell className="text-right">{pos.quantity}주</TableCell>
                            <TableCell className="text-right">${pos.avgPrice.toFixed(2)}</TableCell>
                            <TableCell className="text-right font-medium">${pos.currentPrice.toFixed(2)}</TableCell>
                            <TableCell className="text-right">{formatMoney(pos.evaluationAmount)}원</TableCell>
                            <TableCell className="text-right">
                              <span className={pos.profitRate >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                                {pos.profitRate >= 0 ? '+' : ''}{pos.profitRate.toFixed(1)}%
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <Globe className="h-12 w-12 mb-3 opacity-20" />
                      <p className="text-sm">해외주식 포지션이 없습니다</p>
                      <p className="text-xs mt-1">미국종목 검색으로 종목을 추가해보세요</p>
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            {/* 인기 미국 종목 빠른 추가 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">인기 미국 종목</CardTitle>
                <CardDescription>클릭하여 시세를 확인하거나 관심종목에 추가</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                  {[
                    { code: 'AAPL', name: '애플', exchange: 'NAS' },
                    { code: 'NVDA', name: '엔비디아', exchange: 'NAS' },
                    { code: 'MSFT', name: '마이크로소프트', exchange: 'NAS' },
                    { code: 'GOOGL', name: '알파벳', exchange: 'NAS' },
                    { code: 'AMZN', name: '아마존', exchange: 'NAS' },
                    { code: 'TSLA', name: '테슬라', exchange: 'NAS' },
                    { code: 'META', name: '메타', exchange: 'NAS' },
                    { code: 'NFLX', name: '넷플릭스', exchange: 'NAS' },
                    { code: 'AMD', name: 'AMD', exchange: 'NAS' },
                    { code: 'AVGO', name: '브로드컴', exchange: 'NAS' },
                    { code: 'RKLB', name: '로켓랩🚀', exchange: 'NAS' },
                    { code: 'LUNR', name: '인튜이티브머신스', exchange: 'NAS' },
                    { code: 'ASTS', name: 'AST스페이스모빌', exchange: 'NAS' },
                    { code: 'SPCE', name: '버진갤럭틱', exchange: 'NYS' },
                    { code: 'JOBY', name: '조비에비에이션', exchange: 'NYS' },
                    { code: 'PLTR', name: '팔란티어', exchange: 'NYS' },
                    { code: 'CRWD', name: '크라우드스트라이크', exchange: 'NAS' },
                    { code: 'COIN', name: '코인베이스', exchange: 'NAS' },
                  ].map((stock) => (
                    <Button
                      key={stock.code}
                      variant="outline"
                      className="h-auto py-3 flex flex-col items-center gap-1 hover:bg-blue-50 dark:hover:bg-blue-950"
                      onClick={async () => {
                        try {
                          const res = await fetch(`/api/kis/overseas/price?code=${stock.code}&exchange=${stock.exchange}`);
                          if (res.ok) {
                            const data = await res.json();
                            if (data.success) {
                              alert(`${data.data.stockName} (${data.data.stockCode})\n현재가: $${data.data.currentPrice}\n등락률: ${data.data.changeRate}%`);
                            }
                          }
                        } catch {
                          alert('시세 조회 실패');
                        }
                      }}
                    >
                      <span className="font-mono text-sm font-bold">{stock.code}</span>
                      <span className="text-xs text-muted-foreground">{stock.name}</span>
                    </Button>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 에이전트 탭 ===== */}
          <TabsContent value="agent" className="space-y-6">
            {/* 실행 모드 선택 */}
            <Card className="border-2 border-dashed">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Bot className="h-5 w-5" />
                      AI 자동매매 에이전트 실행
                    </CardTitle>
                    <CardDescription>실행 모드를 선택하고 에이전트를 시작하세요</CardDescription>
                  </div>
                  {/* 장시간 상태 표시 */}
                  <div className="flex items-center gap-2">
                    {schedulerInfo?.currentKST && (
                      <Badge variant="outline" className="text-xs border-gray-300 text-gray-500">
                        <Clock className="h-3 w-3 mr-1" />
                        KST {schedulerInfo.currentKST}
                      </Badge>
                    )}
                    {schedulerInfo?.domesticSession && schedulerInfo.domesticSession.session !== 'CLOSED' && (
                      <Badge variant="outline" className="text-xs border-blue-300 text-blue-600">
                        {schedulerInfo.domesticSession.label}
                      </Badge>
                    )}
                    {schedulerInfo?.isMarketOpen && (
                      <>
                        <Badge variant="outline" className={`text-xs ${schedulerInfo.isMarketOpen.domestic ? 'border-emerald-300 text-emerald-600' : 'border-gray-300 text-gray-400'}`}>
                          국내 {schedulerInfo.isMarketOpen.domestic ? '장 열림' : '장 닫힘'}
                        </Badge>
                        <Badge variant="outline" className={`text-xs ${schedulerInfo.isMarketOpen.overseas ? 'border-blue-300 text-blue-600' : 'border-gray-300 text-gray-400'}`}>
                          해외 {schedulerInfo.isMarketOpen.overseas ? '장 열림' : '장 닫힘'}
                        </Badge>
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* 모드 선택 카드 */}
                <div className="grid gap-4 md:grid-cols-2">
                  <div 
                    className={`cursor-pointer rounded-lg border-2 p-4 transition-all ${
                      agentMode === 'SERVER' 
                        ? 'border-emerald-500 bg-emerald-50/50 dark:bg-emerald-950/20' 
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setAgentMode('SERVER')}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${agentMode === 'SERVER' ? 'bg-emerald-100 dark:bg-emerald-900' : 'bg-gray-100'}`}>
                        <Terminal className={`h-5 w-5 ${agentMode === 'SERVER' ? 'text-emerald-600' : 'text-gray-500'}`} />
                      </div>
                      <div>
                        <h3 className="font-semibold">서버 모드</h3>
                        <p className="text-xs text-muted-foreground">24/7 자동 실행 (권장)</p>
                      </div>
                      {agentMode === 'SERVER' && <CheckCircle className="h-5 w-5 text-emerald-500 ml-auto" />}
                    </div>
                    <ul className="text-xs text-muted-foreground space-y-1.5 ml-1">
                      <li className="flex items-center gap-1.5"><CheckCircle className="h-3 w-3 text-emerald-500" /> 브라우저를 닫아도 계속 실행</li>
                      <li className="flex items-center gap-1.5"><CheckCircle className="h-3 w-3 text-emerald-500" /> 서버 재시작 시 자동 복구</li>
                      <li className="flex items-center gap-1.5"><CheckCircle className="h-3 w-3 text-emerald-500" /> 장시간에만 자동 거래</li>
                      <li className="flex items-center gap-1.5"><CheckCircle className="h-3 w-3 text-emerald-500" /> 클라우드 서버 배포 가능</li>
                    </ul>
                  </div>

                  <div 
                    className={`cursor-pointer rounded-lg border-2 p-4 transition-all ${
                      agentMode === 'BROWSER' 
                        ? 'border-blue-500 bg-blue-50/50 dark:bg-blue-950/20' 
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                    onClick={() => setAgentMode('BROWSER')}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${agentMode === 'BROWSER' ? 'bg-blue-100 dark:bg-blue-900' : 'bg-gray-100'}`}>
                        <Activity className={`h-5 w-5 ${agentMode === 'BROWSER' ? 'text-blue-600' : 'text-gray-500'}`} />
                      </div>
                      <div>
                        <h3 className="font-semibold">브라우저 모드</h3>
                        <p className="text-xs text-muted-foreground">브라우저에서 수동 실행</p>
                      </div>
                      {agentMode === 'BROWSER' && <CheckCircle className="h-5 w-5 text-blue-500 ml-auto" />}
                    </div>
                    <ul className="text-xs text-muted-foreground space-y-1.5 ml-1">
                      <li className="flex items-center gap-1.5"><CircleDot className="h-3 w-3 text-blue-500" /> 브라우저가 열려있어야 실행</li>
                      <li className="flex items-center gap-1.5"><CircleDot className="h-3 w-3 text-blue-500" /> 수동으로 사이클 실행</li>
                      <li className="flex items-center gap-1.5"><CircleDot className="h-3 w-3 text-blue-500" /> 테스트/디버깅용</li>
                      <li className="flex items-center gap-1.5"><XCircle className="h-3 w-3 text-gray-400" /> 탭 닫으면 매매 중지</li>
                    </ul>
                  </div>
                </div>

                {/* 시작/중지 버튼 */}
                <div className="flex items-center gap-3 pt-2">
                  {tradingStatus !== 'RUNNING' ? (
                    <Button 
                      size="lg"
                      onClick={startTrading} 
                      disabled={isLoading}
                      className="bg-emerald-600 hover:bg-emerald-700 flex-1"
                    >
                      <Play className="h-5 w-5 mr-2" />
                      {agentMode === 'SERVER' ? '서버 모드로 시작 (24/7)' : '브라우저 모드로 시작'}
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2 flex-1">
                      <Badge className="bg-emerald-500 text-white py-1 px-3">
                        <div className="h-2 w-2 rounded-full bg-white animate-pulse mr-2" />
                        {schedulerInfo?.isSchedulerRunning ? '서버 모드 실행 중' : '브라우저 모드 실행 중'}
                      </Badge>
                      <Button 
                        size="sm" 
                        variant="destructive" 
                        onClick={stopTrading}
                        disabled={isLoading}
                      >
                        <Square className="h-4 w-4 mr-1" />
                        중지
                      </Button>
                      <Button 
                        onClick={runOneCycle} 
                        disabled={isRunningCycle}
                        size="sm"
                        variant="outline"
                      >
                        <RotateCw className={`h-4 w-4 mr-1 ${isRunningCycle ? 'animate-spin' : ''}`} />
                        1사이클 수동 실행
                      </Button>
                    </div>
                  )}
                </div>

                {/* 서버 모드 안내 */}
                {agentMode === 'SERVER' && tradingStatus !== 'RUNNING' && (
                  <Alert className="bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800">
                    <Terminal className="h-4 w-4 text-emerald-600" />
                    <AlertDescription className="text-sm">
                      서버 모드로 시작하면 브라우저를 닫아도 서버에서 자동으로 매매가 진행됩니다. 
                      클라우드 서버(AWS, GCP 등)에 배포하면 24/7 끊김 없이 실행할 수 있습니다.
                    </AlertDescription>
                  </Alert>
                )}
              </CardContent>
            </Card>

            {/* 에이전트 상태 카드 */}
            <div className="grid gap-4 md:grid-cols-4">
              <Card className={tradingStatus === 'RUNNING' ? 'border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-800' : ''}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className={`rounded-full p-3 ${tradingStatus === 'RUNNING' ? 'bg-emerald-100 dark:bg-emerald-900' : 'bg-gray-100 dark:bg-gray-800'}`}>
                      <Bot className={`h-6 w-6 ${tradingStatus === 'RUNNING' ? 'text-emerald-600' : 'text-gray-600'}`} />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">에이전트 상태</p>
                      <p className={`text-2xl font-bold ${tradingStatus === 'RUNNING' ? 'text-emerald-600' : tradingStatus === 'PAUSED' ? 'text-amber-600' : 'text-gray-600'}`}>
                        {tradingStatus === 'RUNNING' ? '실행 중' : tradingStatus === 'PAUSED' ? '일시정지' : '대기'}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-blue-100 p-3 dark:bg-blue-900">
                      <RefreshCw className="h-6 w-6 text-blue-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">실행 사이클</p>
                      <p className="text-2xl font-bold">{schedulerInfo?.totalCycles || agentStatus?.totalCycles || 0}회</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-violet-100 p-3 dark:bg-violet-900">
                      <Zap className="h-6 w-6 text-violet-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">총 주문 건수</p>
                      <p className="text-2xl font-bold">{schedulerInfo?.totalTrades || agentStatus?.totalTrades || 0}건</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-3">
                    <div className="rounded-full bg-amber-100 p-3 dark:bg-amber-900">
                      <Clock className="h-6 w-6 text-amber-600" />
                    </div>
                    <div>
                      <p className="text-sm text-muted-foreground">다음 실행</p>
                      <p className="text-lg font-bold">
                        {schedulerInfo?.nextCycleAt 
                          ? new Date(schedulerInfo.nextCycleAt).toLocaleTimeString('ko-KR')
                          : agentStatus?.lastCycleTime
                            ? new Date(agentStatus.lastCycleTime).toLocaleTimeString('ko-KR')
                            : '-'
                        }
                      </p>
                      {schedulerInfo?.nextCycleAt && (
                        <p className="text-xs text-muted-foreground">다음 사이클</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* 스케줄러 설정 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Settings className="h-5 w-5" />
                  스케줄러 설정
                </CardTitle>
                <CardDescription>에이전트 자동 실행 주기 및 장시간 설정</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  {/* 사이클 주기 */}
                  <div className="space-y-2">
                    <Label>사이클 실행 주기</Label>
                    <Select 
                      value={String(schedulerInfo?.config?.cycleIntervalMs || 60000)} 
                      onValueChange={async (value) => {
                        await fetch('/api/agent/scheduler', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ cycleIntervalMs: parseInt(value) }),
                        });
                        loadAgentStatus();
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="30000">30초마다</SelectItem>
                        <SelectItem value="60000">1분마다 (권장)</SelectItem>
                        <SelectItem value="120000">2분마다</SelectItem>
                        <SelectItem value="300000">5분마다</SelectItem>
                        <SelectItem value="600000">10분마다</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* 장시간 거래 제한 */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>장시간에만 거래</Label>
                      <Switch 
                        checked={schedulerInfo?.config?.tradeOnlyMarketHours ?? true}
                        onCheckedChange={async (checked) => {
                          await fetch('/api/agent/scheduler', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ tradeOnlyMarketHours: checked }),
                          });
                          loadAgentStatus();
                        }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {schedulerInfo?.config?.tradeOnlyMarketHours !== false 
                        ? '장시간(09:00~15:30, 23:30~06:00)에만 자동 주문 실행' 
                        : '24시간 주기로 분석 실행 (장외 시간은 신호만 기록)'}
                    </p>
                  </div>
                </div>

                {/* 장시간 설정 */}
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-sm">국내 장시간</Label>
                    <div className="flex items-center gap-2">
                      <Input 
                        value={schedulerInfo?.config?.domesticMarketOpen || '09:00'} 
                        className="w-24 text-center" 
                        onChange={async (e) => {
                          await fetch('/api/agent/scheduler', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ domesticMarketOpen: e.target.value }),
                          });
                        }}
                      />
                      <span className="text-muted-foreground">~</span>
                      <Input 
                        value={schedulerInfo?.config?.domesticMarketClose || '15:30'} 
                        className="w-24 text-center"
                        onChange={async (e) => {
                          await fetch('/api/agent/scheduler', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ domesticMarketClose: e.target.value }),
                          });
                        }}
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm">해외 장시간 (한국시간)</Label>
                    <div className="flex items-center gap-2">
                      <Input 
                        value={schedulerInfo?.config?.overseasMarketOpen || '23:30'} 
                        className="w-24 text-center"
                        onChange={async (e) => {
                          await fetch('/api/agent/scheduler', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ overseasMarketOpen: e.target.value }),
                          });
                        }}
                      />
                      <span className="text-muted-foreground">~</span>
                      <Input 
                        value={schedulerInfo?.config?.overseasMarketClose || '06:00'} 
                        className="w-24 text-center"
                        onChange={async (e) => {
                          await fetch('/api/agent/scheduler', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ overseasMarketClose: e.target.value }),
                          });
                        }}
                      />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 마지막 사이클 결과 */}
            {agentStatus?.lastCycleSummary && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">마지막 사이클 결과</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 grid-cols-5 text-center">
                    <div>
                      <p className="text-2xl font-bold text-blue-600">{agentStatus.lastCycleSummary.stocksAnalyzed}</p>
                      <p className="text-xs text-muted-foreground">분석 종목</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-emerald-600">{agentStatus.lastCycleSummary.signalsGenerated}</p>
                      <p className="text-xs text-muted-foreground">발생 신호</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-violet-600">{agentStatus.lastCycleSummary.ordersPlaced}</p>
                      <p className="text-xs text-muted-foreground">실행 주문</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-amber-600">{agentStatus.lastCycleSummary.positionsMonitored}</p>
                      <p className="text-xs text-muted-foreground">모니터링 포지션</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-red-600">{agentStatus.lastCycleSummary.exitsExecuted}</p>
                      <p className="text-xs text-muted-foreground">자동 청산</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* 에이전트 작동 원리 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">에이전트 작동 원리</CardTitle>
                <CardDescription>1사이클 실행 시 아래 순서로 자동 매매가 진행됩니다</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 md:grid-cols-4">
                  <div className="flex flex-col items-center rounded-lg border p-4 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900 mb-2">
                      <span className="text-lg font-bold text-blue-600">1</span>
                    </div>
                    <p className="font-medium text-sm">데이터 수집</p>
                    <p className="text-xs text-muted-foreground mt-1">KIS API에서 실시간 캔들 데이터 조회</p>
                  </div>
                  <div className="flex flex-col items-center rounded-lg border p-4 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-900 mb-2">
                      <span className="text-lg font-bold text-violet-600">2</span>
                    </div>
                    <p className="font-medium text-sm">AI 시그널 분석</p>
                    <p className="text-xs text-muted-foreground mt-1">5대 전략 가중평균으로 매수/매도 판단</p>
                  </div>
                  <div className="flex flex-col items-center rounded-lg border p-4 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900 mb-2">
                      <span className="text-lg font-bold text-amber-600">3</span>
                    </div>
                    <p className="font-medium text-sm">리스크 체크</p>
                    <p className="text-xs text-muted-foreground mt-1">손실한도, 포지션 수, 신뢰도 검증</p>
                  </div>
                  <div className="flex flex-col items-center rounded-lg border p-4 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900 mb-2">
                      <span className="text-lg font-bold text-emerald-600">4</span>
                    </div>
                    <p className="font-medium text-sm">자동 주문 실행</p>
                    <p className="text-xs text-muted-foreground mt-1">KIS API로 매수/매도 주문 + 포지션 모니터링</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 서버 배포 가이드 */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Globe className="h-5 w-5" />
                  24/7 실행 방법 (클라우드 배포)
                </CardTitle>
                <CardDescription>컴퓨터를 켜두지 않아도 클라우드 서버에서 24시간 실행 가능</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <Badge className="bg-blue-500 text-white shrink-0 mt-0.5">1</Badge>
                    <div>
                      <p className="font-medium text-sm">KIS API 키 설정</p>
                      <p className="text-xs text-muted-foreground">위 &quot;API 설정&quot; 버튼으로 App Key, App Secret, 계좌번호를 입력하세요. 모의투자 모드로 먼저 테스트하는 것을 권장합니다.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <Badge className="bg-blue-500 text-white shrink-0 mt-0.5">2</Badge>
                    <div>
                      <p className="font-medium text-sm">관심종목 추가</p>
                      <p className="text-xs text-muted-foreground">관심종목 탭에서 분석할 종목을 추가하세요. 추가된 종목만 자동매매 대상이 됩니다.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <Badge className="bg-blue-500 text-white shrink-0 mt-0.5">3</Badge>
                    <div>
                      <p className="font-medium text-sm">서버 모드로 시작</p>
                      <p className="text-xs text-muted-foreground">위에서 &quot;서버 모드로 시작 (24/7)&quot; 버튼을 클릭하면 서버에서 자동으로 매매가 시작됩니다.</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 rounded-lg border p-3">
                    <Badge className="bg-violet-500 text-white shrink-0 mt-0.5">A</Badge>
                    <div>
                      <p className="font-medium text-sm">클라우드 배포 (선택사항)</p>
                      <p className="text-xs text-muted-foreground">AWS Lightsail, GCP Compute Engine, Oracle Cloud 등에 이 앱을 배포하면 컴퓨터를 끄고 외출해도 24/7 자동매매가 계속 실행됩니다. 월 5천원~1만원대 가상서버면 충분합니다.</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* 실시간 에이전트 로그 */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">에이전트 실행 로그</CardTitle>
                    <CardDescription>자동매매 에이전트의 실시간 작업 기록</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {schedulerInfo?.isSchedulerRunning && (
                      <Badge className="bg-emerald-500 text-white text-xs">
                        <div className="h-1.5 w-1.5 rounded-full bg-white animate-pulse mr-1.5" />
                        서버 실행 중
                      </Badge>
                    )}
                    <Badge variant="outline" className="text-xs">
                      {agentLogs.length}건
                      {(isRunningCycle || schedulerInfo?.isCycleRunning) && ' · 실행 중...'}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[400px]">
                  {agentLogs.length > 0 ? (
                    <div className="space-y-2 font-mono text-sm">
                      {agentLogs.map((log) => (
                        <div 
                          key={log.id}
                          className={`flex items-start gap-2 rounded-md px-3 py-2 ${
                            log.type === 'ERROR' ? 'bg-red-50 dark:bg-red-950/20' :
                            log.type === 'TRADE' ? 'bg-violet-50 dark:bg-violet-950/20' :
                            log.type === 'SIGNAL' ? 'bg-emerald-50 dark:bg-emerald-950/20' :
                            log.type === 'EXIT' ? 'bg-amber-50 dark:bg-amber-950/20' :
                            log.type === 'RISK' ? 'bg-orange-50 dark:bg-orange-950/20' :
                            'bg-muted/30'
                          }`}
                        >
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            {new Date(log.timestamp).toLocaleTimeString('ko-KR')}
                          </span>
                          <Badge variant="outline" className="text-xs py-0 px-1 shrink-0">
                            {log.type}
                          </Badge>
                          <Badge variant="outline" className="text-xs py-0 px-1 shrink-0">
                            {log.market === 'DOMESTIC' ? '국내' : '해외'}
                          </Badge>
                          <span className="text-xs">{log.message}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                      <Terminal className="h-12 w-12 mb-3 opacity-20" />
                      <p className="text-sm">아직 실행 로그가 없습니다</p>
                      <p className="text-xs mt-1">에이전트를 시작하고 사이클을 실행하세요</p>
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 전략 탭 ===== */}
          <TabsContent value="strategy" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">매매 전략 관리</h2>
                <p className="text-sm text-muted-foreground">인터넷/유튜브 수익률 검증 전략 5종</p>
              </div>
            </div>

            <div className="grid gap-4">
              {strategies.map((strategy) => (
                <Card key={strategy.id} className={strategy.isActive ? 'border-l-4 border-l-emerald-500' : 'opacity-70'}>
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <StrategyTypeBadge type={strategy.type} />
                          <CardTitle className="text-base">{strategy.name}</CardTitle>
                        </div>
                        <CardDescription className="max-w-2xl">{strategy.description}</CardDescription>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="text-sm font-medium">수익률</div>
                          <div className="text-lg font-bold text-emerald-600">+{strategy.profitRate}%</div>
                        </div>
                        <Separator orientation="vertical" className="h-10" />
                        <div className="text-right">
                          <div className="text-sm font-medium">승률</div>
                          <div className="text-lg font-bold">{strategy.winRate}%</div>
                        </div>
                        <Separator orientation="vertical" className="h-10" />
                        <Switch 
                          checked={strategy.isActive}
                          onCheckedChange={async (checked) => {
                            await fetch('/api/strategy/list', {
                              method: 'PUT',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ id: strategy.id, isActive: checked }),
                            });
                            loadDashboardData();
                          }}
                        />
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>

            {/* 전략 비교 */}
            <Card>
              <CardHeader>
                <CardTitle>전략별 성과 비교</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>전략</TableHead>
                      <TableHead>유형</TableHead>
                      <TableHead className="text-right">백테스트 수익률</TableHead>
                      <TableHead className="text-right">승률</TableHead>
                      <TableHead className="text-right">활성</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {strategies.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.name}</TableCell>
                        <TableCell><StrategyTypeBadge type={s.type} /></TableCell>
                        <TableCell className="text-right">
                          <span className="text-emerald-600 font-semibold">+{s.profitRate}%</span>
                        </TableCell>
                        <TableCell className="text-right">{s.winRate}%</TableCell>
                        <TableCell className="text-right">
                          {s.isActive ? <CheckCircle className="h-4 w-4 text-emerald-500 inline" /> : <XCircle className="h-4 w-4 text-gray-400 inline" />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ===== 리스크 탭 ===== */}
          <TabsContent value="risk" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">리스크 관리</h2>
                <p className="text-sm text-muted-foreground">자동매매 안전장치 및 손실 방지 설정</p>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              {/* 포지션 사이즈 제한 */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Target className="h-5 w-5" />
                    포지션 사이즈 제한
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>최대 포지션 비중</Label>
                      <span className="text-sm font-medium">{riskConfig.maxPositionSize}%</span>
                    </div>
                    <Progress value={riskConfig.maxPositionSize} max={30} className="h-2" />
                    <Input 
                      type="range" 
                      min={1} max={30} 
                      value={riskConfig.maxPositionSize} 
                      onChange={(e) => setRiskConfig({...riskConfig, maxPositionSize: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">1회 매수 시 계좌의 최대 비중</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>최대 동시 포지션</Label>
                      <span className="text-sm font-medium">{riskConfig.maxOpenPositions}개</span>
                    </div>
                    <div className="flex gap-2">
                      {[3, 5, 7, 10].map(n => (
                        <Button 
                          key={n}
                          size="sm"
                          variant={riskConfig.maxOpenPositions === n ? 'default' : 'outline'}
                          onClick={() => setRiskConfig({...riskConfig, maxOpenPositions: n})}
                        >
                          {n}개
                        </Button>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* 손실 제한 */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="h-5 w-5" />
                    손실 제한 설정
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>일일 최대 손실</Label>
                      <span className="text-sm font-medium text-red-600">{riskConfig.maxDailyLoss}%</span>
                    </div>
                    <Input 
                      type="range" 
                      min={1} max={10} 
                      value={riskConfig.maxDailyLoss} 
                      onChange={(e) => setRiskConfig({...riskConfig, maxDailyLoss: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">하루 최대 허용 손실률 (초과 시 자동 중지)</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>총 최대 손실</Label>
                      <span className="text-sm font-medium text-red-600">{riskConfig.maxTotalLoss}%</span>
                    </div>
                    <Input 
                      type="range" 
                      min={5} max={30} 
                      value={riskConfig.maxTotalLoss} 
                      onChange={(e) => setRiskConfig({...riskConfig, maxTotalLoss: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">누적 최대 허용 손실률 (초과 시 전체 청산)</p>
                  </div>
                </CardContent>
              </Card>

              {/* 손절/익절 설정 */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <AlertTriangle className="h-5 w-5" />
                    손절 / 익절 설정
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>손절 기준</Label>
                      <span className="text-sm font-medium text-red-600">-{riskConfig.stopLoss}%</span>
                    </div>
                    <Input 
                      type="range" 
                      min={1} max={15} 
                      value={riskConfig.stopLoss} 
                      onChange={(e) => setRiskConfig({...riskConfig, stopLoss: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">매수가 대비 하락 시 자동 매도</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>익절 기준</Label>
                      <span className="text-sm font-medium text-emerald-600">+{riskConfig.takeProfit}%</span>
                    </div>
                    <Input 
                      type="range" 
                      min={5} max={50} 
                      value={riskConfig.takeProfit} 
                      onChange={(e) => setRiskConfig({...riskConfig, takeProfit: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">목표 수익률 도달 시 자동 매도</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>트레일링 스톱</Label>
                      <span className="text-sm font-medium">{riskConfig.trailingStop}%</span>
                    </div>
                    <Input 
                      type="range" 
                      min={1} max={10} 
                      value={riskConfig.trailingStop} 
                      onChange={(e) => setRiskConfig({...riskConfig, trailingStop: parseInt(e.target.value)})}
                      className="w-full"
                    />
                    <p className="text-xs text-muted-foreground">최고가 대비 하락 시 자동 매도</p>
                  </div>
                </CardContent>
              </Card>

              {/* 리스크 요약 */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Shield className="h-5 w-5" />
                    리스크 요약
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Alert>
                    <Shield className="h-4 w-4" />
                    <AlertDescription>
                      <strong>안전 장치 요약</strong>
                    </AlertDescription>
                  </Alert>
                  
                  <div className="space-y-3">
                    {[
                      { label: '1회 최대 매수 비중', value: `${riskConfig.maxPositionSize}%`, desc: '계좌 대비' },
                      { label: '최대 동시 보유', value: `${riskConfig.maxOpenPositions}종목`, desc: '분산 효과' },
                      { label: '일일 손실 한도', value: `-${riskConfig.maxDailyLoss}%`, desc: '자동 중지' },
                      { label: '총 손실 한도', value: `-${riskConfig.maxTotalLoss}%`, desc: '전체 청산' },
                      { label: '손절 라인', value: `-${riskConfig.stopLoss}%`, desc: '개별 포지션' },
                      { label: '익절 라인', value: `+${riskConfig.takeProfit}%`, desc: '목표 달성' },
                      { label: '트레일링 스톱', value: `-${riskConfig.trailingStop}%`, desc: '최고가 대비' },
                    ].map((item, i) => (
                      <div key={i} className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">{item.label}</span>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{item.value}</span>
                          <Badge variant="outline" className="text-xs">{item.desc}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>

                  <Button 
                    className="w-full mt-4"
                    onClick={async () => {
                      // 1) 기존 /api/risk에 저장
                      await fetch('/api/risk', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          maxPositionSize: riskConfig.maxPositionSize / 100,
                          maxDailyLoss: riskConfig.maxDailyLoss / 100,
                          maxTotalLoss: riskConfig.maxTotalLoss / 100,
                          maxOpenPositions: riskConfig.maxOpenPositions,
                          stopLossPercent: riskConfig.stopLoss / 100,
                          takeProfitPercent: riskConfig.takeProfit / 100,
                          trailingStopPercent: riskConfig.trailingStop / 100,
                        }),
                      });
                      // 2) /api/settings/trading에도 통합 저장 (영속 보장)
                      await fetch('/api/settings/trading', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          maxPositionSize: riskConfig.maxPositionSize / 100,
                          maxDailyLoss: riskConfig.maxDailyLoss / 100,
                          maxTotalLoss: riskConfig.maxTotalLoss / 100,
                          maxOpenPositions: riskConfig.maxOpenPositions,
                          stopLossPercent: riskConfig.stopLoss / 100,
                          takeProfitPercent: riskConfig.takeProfit / 100,
                          trailingStopPercent: riskConfig.trailingStop / 100,
                          selectedStrategy,
                        }),
                      });
                      // localStorage에도 동기화
                      localStorage.setItem('trading_settings', JSON.stringify({
                        maxPositionSize: riskConfig.maxPositionSize / 100,
                        maxDailyLoss: riskConfig.maxDailyLoss / 100,
                        maxTotalLoss: riskConfig.maxTotalLoss / 100,
                        maxOpenPositions: riskConfig.maxOpenPositions,
                        stopLossPercent: riskConfig.stopLoss / 100,
                        takeProfitPercent: riskConfig.takeProfit / 100,
                        trailingStopPercent: riskConfig.trailingStop / 100,
                        selectedStrategy,
                      }));
                    }}
                  >
                    리스크 설정 저장
                  </Button>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </main>

      {/* 푸터 */}
      <footer className="border-t py-4 mt-8">
        <div className="container flex items-center justify-between px-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4" />
            <span>AI Trading Agent v1.0 | 한국투자증권 KIS Open API</span>
          </div>
          <div className="flex items-center gap-4">
            <span>전략: 5종 | 지표: 7개 | 리스크관리: 활성</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
