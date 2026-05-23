// 글로벌 상태 관리 (Zustand)

import { create } from 'zustand';

export interface TradingState {
  // 자동매매 상태
  tradingStatus: 'RUNNING' | 'STOPPED' | 'PAUSED';
  setTradingStatus: (status: 'RUNNING' | 'STOPPED' | 'PAUSED') => void;
  
  // 선택된 전략
  selectedStrategy: string;
  setSelectedStrategy: (strategy: string) => void;
  
  // 계좌 정보
  accountBalance: number;
  setAccountBalance: (balance: number) => void;
  
  // 오늘 수익
  todayProfit: number;
  setTodayProfit: (profit: number) => void;
  
  // 신호 목록
  signals: TradingSignalItem[];
  setSignals: (signals: TradingSignalItem[]) => void;
  addSignal: (signal: TradingSignalItem) => void;
  
  // 포지션
  positions: PositionItem[];
  setPositions: (positions: PositionItem[]) => void;
  
  // 거래 내역
  tradeHistory: TradeHistoryItem[];
  setTradeHistory: (trades: TradeHistoryItem[]) => void;
  
  // KIS 설정 상태
  kisConfigured: boolean;
  setKisConfigured: (configured: boolean) => void;
  
  // 활성 탭
  activeTab: string;
  setActiveTab: (tab: string) => void;
  
  // 로딩 상태
  isLoading: boolean;
  setLoading: (loading: boolean) => void;
  
  // 자동 새로고침
  autoRefresh: boolean;
  setAutoRefresh: (refresh: boolean) => void;
}

export interface TradingSignalItem {
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

export interface PositionItem {
  stockCode: string;
  stockName: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  profitLoss: number;
  profitRate: number;
  evaluationAmount: number;
}

export interface TradeHistoryItem {
  id: string;
  stockCode: string;
  stockName: string;
  tradeType: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  totalAmount: number;
  strategy: string;
  profitLoss?: number;
  profitRate?: number;
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

export const useTradingStore = create<TradingState>((set) => ({
  tradingStatus: 'STOPPED',
  setTradingStatus: (status) => set({ tradingStatus: status }),
  
  selectedStrategy: 'ALL',
  setSelectedStrategy: (strategy) => set({ selectedStrategy: strategy }),
  
  accountBalance: 0,
  setAccountBalance: (balance) => set({ accountBalance: balance }),
  
  todayProfit: 0,
  setTodayProfit: (profit) => set({ todayProfit: profit }),
  
  signals: [],
  setSignals: (signals) => set({ signals }),
  addSignal: (signal) => set((state) => ({ signals: [signal, ...state.signals].slice(0, 50) })),
  
  positions: [],
  setPositions: (positions) => set({ positions }),
  
  tradeHistory: [],
  setTradeHistory: (trades) => set({ tradeHistory: trades }),
  
  kisConfigured: false,
  setKisConfigured: (configured) => set({ kisConfigured: configured }),
  
  activeTab: 'dashboard',
  setActiveTab: (tab) => set({ activeTab: tab }),
  
  isLoading: false,
  setLoading: (loading) => set({ isLoading: loading }),
  
  autoRefresh: true,
  setAutoRefresh: (refresh) => set({ autoRefresh: refresh }),
}));
