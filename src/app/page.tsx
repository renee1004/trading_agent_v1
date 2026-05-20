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
  LineChart, CandlestickChart, Target, Coins
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
  const [accountBalance, setAccountBalance] = useState(50000000);
  const [todayProfit, setTodayProfit] = useState(1250000);
  const [totalProfitRate, setTotalProfitRate] = useState(4.6);
  const [kisConfigured, setKisConfigured] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');

  // KIS 설정 다이얼로그
  const [showKisDialog, setShowKisDialog] = useState(false);
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [accountNo, setAccountNo] = useState('');
  const [isDemo, setIsDemo] = useState(true);

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

  // 데이터 로드
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
    } catch (error) {
      console.error('데이터 로드 실패:', error);
    }
  }, [selectedStrategy]);

  // 초기 로드 및 자동 새로고침
  useEffect(() => {
    let mounted = true;
    const fetchData = async () => {
      if (!mounted) return;
      await loadDashboardData();
    };
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => { mounted = false; clearInterval(interval); };
  }, [selectedStrategy, loadDashboardData]);

  // 자동매매 시작
  const startTrading = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/trading/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'START', strategyId: selectedStrategy }),
      });
      const data = await res.json();
      if (data.success) {
        setTradingStatus('RUNNING');
      }
    } catch (error) {
      console.error('자동매매 시작 실패:', error);
    }
    setIsLoading(false);
  };

  // 자동매매 중지
  const stopTrading = async () => {
    setIsLoading(true);
    try {
      await fetch('/api/trading/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'STOP' }),
      });
      setTradingStatus('STOPPED');
    } catch (error) {
      console.error('자동매매 중지 실패:', error);
    }
    setIsLoading(false);
  };

  // KIS 설정 저장
  const saveKisConfig = async () => {
    try {
      const res = await fetch('/api/kis/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey, appSecret, accountNo, isDemo }),
      });
      const data = await res.json();
      if (data.success) {
        setKisConfigured(true);
        setShowKisDialog(false);
        // 토큰 발급 시도
        await fetch('/api/kis/token', { method: 'POST' });
      }
    } catch (error) {
      console.error('KIS 설정 실패:', error);
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

            <Dialog open={showKisDialog} onOpenChange={setShowKisDialog}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Settings className="h-4 w-4 mr-1" />
                  API 설정
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>한국투자증권 API 설정</DialogTitle>
                  <DialogDescription>
                    KIS Developers에서 발급받은 App Key와 App Secret을 입력하세요.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="flex items-center gap-2">
                    <Switch checked={isDemo} onCheckedChange={setIsDemo} />
                    <Label>모의투자 모드</Label>
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
                      placeholder="xxxxxxxx" 
                      type="password" 
                      value={appSecret} 
                      onChange={(e) => setAppSecret(e.target.value)} 
                    />
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
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setShowKisDialog(false)}>취소</Button>
                  <Button onClick={saveKisConfig}>저장</Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      {/* 메인 컨텐츠 */}
      <main className="container px-4 py-6">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="dashboard"><Activity className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">대시보드</span></TabsTrigger>
            <TabsTrigger value="signals"><Zap className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">매매신호</span></TabsTrigger>
            <TabsTrigger value="positions"><Wallet className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">포지션</span></TabsTrigger>
            <TabsTrigger value="strategy"><BarChart3 className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">전략</span></TabsTrigger>
            <TabsTrigger value="risk"><Shield className="h-4 w-4 mr-1 sm:mr-2" /><span className="hidden sm:inline">리스크</span></TabsTrigger>
          </TabsList>

          {/* ===== 대시보드 탭 ===== */}
          <TabsContent value="dashboard" className="space-y-6">
            {/* 요약 카드 */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">총 자산</CardTitle>
                  <Coins className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{formatFullMoney(accountBalance + todayProfit)}원</div>
                  <p className="text-xs text-muted-foreground">
                    예수금: {formatMoney(accountBalance)}원
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">오늘 수익</CardTitle>
                  {todayProfit >= 0 ? <ArrowUpRight className="h-4 w-4 text-emerald-500" /> : <ArrowDownRight className="h-4 w-4 text-red-500" />}
                </CardHeader>
                <CardContent>
                  <div className={`text-2xl font-bold ${todayProfit >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {todayProfit >= 0 ? '+' : ''}{formatFullMoney(todayProfit)}원
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
                  <div className={`text-2xl font-bold ${totalProfitRate >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {totalProfitRate >= 0 ? '+' : ''}{totalProfitRate.toFixed(1)}%
                  </div>
                  <p className="text-xs text-muted-foreground">
                    보유 포지션 {positions.length}개
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
                          <TableHead>전략</TableHead>
                          <TableHead>상태</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {trades.map((trade) => (
                          <TableRow key={trade.id}>
                            <TableCell className="text-xs">
                              {new Date(trade.tradedAt).toLocaleString('ko-KR')}
                            </TableCell>
                            <TableCell>
                              <div className="font-medium">{trade.stockName}</div>
                            </TableCell>
                            <TableCell>
                              <SignalBadge type={trade.tradeType} />
                            </TableCell>
                            <TableCell>{trade.quantity}주</TableCell>
                            <TableCell>{formatFullMoney(trade.price)}원</TableCell>
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
                        ))}
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

          {/* ===== 포지션 탭 ===== */}
          <TabsContent value="positions" className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold">포지션 관리</h2>
                <p className="text-sm text-muted-foreground">현재 보유 및 거래 내역 관리</p>
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">총 평가금액</p>
                  <p className="text-2xl font-bold">{formatMoney(positions.reduce((s, p) => s + p.evaluationAmount, 0))}원</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">총 평가손익</p>
                  <p className={`text-2xl font-bold ${positions.reduce((s, p) => s + p.profitLoss, 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {formatMoney(positions.reduce((s, p) => s + p.profitLoss, 0))}원
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">보유 종목 수</p>
                  <p className="text-2xl font-bold">{positions.length}개</p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>보유 포지션 상세</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>종목</TableHead>
                      <TableHead className="text-right">수량</TableHead>
                      <TableHead className="text-right">매입가</TableHead>
                      <TableHead className="text-right">현재가</TableHead>
                      <TableHead className="text-right">평가금</TableHead>
                      <TableHead className="text-right">손익</TableHead>
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
                        <TableCell className="text-right">{formatFullMoney(pos.avgPrice)}원</TableCell>
                        <TableCell className="text-right">{formatFullMoney(pos.currentPrice)}원</TableCell>
                        <TableCell className="text-right">{formatMoney(pos.evaluationAmount)}원</TableCell>
                        <TableCell className={`text-right ${pos.profitLoss >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {formatMoney(pos.profitLoss)}원
                        </TableCell>
                        <TableCell className={`text-right font-medium ${pos.profitRate >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {pos.profitRate >= 0 ? '+' : ''}{pos.profitRate.toFixed(2)}%
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
