// AI 시장 분석기
// z-ai-web-dev-sdk를 활용한 LLM 기반 시장 분석
// 기술적 지표 분석 결과를 LLM이 검증/보강하여 더 정확한 매매 신호 생성

import ZAI from 'z-ai-web-dev-sdk';
import { TradingSignal, MarketType } from './types';

// LLM 분석 결과 인터페이스
export interface AIAnalysisResult {
  /** LLM이 권장하는 액션 */
  recommendation: 'BUY' | 'SELL' | 'HOLD';
  /** 신뢰도 (0-100) */
  confidence: number;
  /** LLM 분석 요약 */
  summary: string;
  /** 리스크 평가 */
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  /** 주의사항 */
  warnings: string[];
  /** 시장 심리 */
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}

// LLM 호출 실패 시 기본값
const DEFAULT_AI_RESULT: AIAnalysisResult = {
  recommendation: 'HOLD',
  confidence: 0,
  summary: 'AI 분석을 사용할 수 없습니다.',
  riskLevel: 'MEDIUM',
  warnings: ['AI 분석 비활성화'],
  sentiment: 'NEUTRAL',
};

/**
 * 주식 시장 분석 프롬프트 생성
 * 기술적 지표 결과를 포함하여 LLM이 종합 판단할 수 있도록 구성
 */
function buildAnalysisPrompt(
  stockName: string,
  stockCode: string,
  market: MarketType,
  signal: TradingSignal,
  marketContext?: string,
): string {
  const marketLabel = market === 'DOMESTIC' ? '한국 주식시장' : '미국 주식시장';
  const currencyLabel = market === 'DOMESTIC' ? '원' : '달러';

  // 지표값 포맷팅
  const indicators = Object.entries(signal.indicators)
    .map(([key, value]) => `- ${key}: ${typeof value === 'number' ? value.toFixed(2) : value}`)
    .join('\n');

  return `당신은 전문 주식 트레이더이자 시장 분석가입니다. ${marketLabel}의 ${stockName}(${stockCode}) 종목을 분석해 주세요.

## 기술적 분석 결과
- 전략: ${signal.strategy}
- 기술적 신호: ${signal.signalType}
- 신뢰도: ${signal.confidence}%
- 현재가: ${signal.price.toLocaleString()}${currencyLabel}
- 판단 근거: ${signal.reason}

## 기술적 지표 상세
${indicators || '지표 데이터 없음'}

${marketContext ? `## 시장 컨텍스트\n${marketContext}\n` : ''}

## 분석 요청
위 기술적 분석 결과를 바탕으로 다음을 평가해 주세요:

1. 기술적 신호(${signal.signalType})가 시장 상황과 일치하는지 검증
2. 현재 시장 심리(BULLISH/BEARISH/NEUTRAL) 판단
3. 리스크 수준(LOW/MEDIUM/HIGH) 평가
4. 주의사항이나 위험 요소
5. 최종 권장 액션(BUY/SELL/HOLD)과 신뢰도(0-100)

반드시 아래 JSON 형식으로만 응답하세요. 다른 텍스트는 포함하지 마세요:
{
  "recommendation": "BUY|SELL|HOLD",
  "confidence": 0-100,
  "summary": "분석 요약 (2-3문장)",
  "riskLevel": "LOW|MEDIUM|HIGH",
  "warnings": ["주의사항1", "주의사항2"],
  "sentiment": "BULLISH|BEARISH|NEUTRAL"
}`;
}

/**
 * 포트폴리오 전체 리스크 평가 프롬프트
 */
function buildPortfolioRiskPrompt(
  positionsSummary: string,
  newSignal: TradingSignal,
): string {
  return `당신은 포트폴리오 리스크 관리자입니다. 새로운 매매 신호에 대해 포트폴리오 전체 관점에서 평가해 주세요.

## 현재 포트폴리오
${positionsSummary}

## 새 매매 신호
- 종목: ${newSignal.stockName}(${newSignal.stockCode})
- 신호: ${newSignal.signalType}
- 신뢰도: ${newSignal.confidence}%
- 전략: ${newSignal.strategy}
- 이유: ${newSignal.reason}

## 평가 요청
1. 이 신호가 포트폴리오 다각화에 미치는 영향
2. 섹터 집중 리스크
3. 전체 포트폴리오 리스크 수준
4. 이 거래를 진행해야 하는지 여부

반드시 아래 JSON 형식으로만 응답하세요:
{
  "recommendation": "BUY|SELL|HOLD",
  "confidence": 0-100,
  "summary": "평가 요약",
  "riskLevel": "LOW|MEDIUM|HIGH",
  "warnings": ["주의사항"],
  "sentiment": "BULLISH|BEARISH|NEUTRAL"
}`;
}

/**
 * AI 분석기 싱글톤
 * z-ai-web-dev-sdk 초기화 및 LLM 호출 관리
 */
class AIAnalyzer {
  private zai: ZAI | null = null;
  private initPromise: Promise<ZAI | null> | null = null;
  private lastCallTime: number = 0;
  private readonly MIN_CALL_INTERVAL_MS = 3000; // API 호출 간 최소 3초 간격

  /**
   * ZAI SDK 초기화 (lazy initialization)
   */
  private async initialize(): Promise<ZAI | null> {
    if (this.zai) return this.zai;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const zai = await ZAI.create();
        this.zai = zai;
        console.log('[AI Analyzer] ZAI SDK 초기화 성공');
        return zai;
      } catch (error) {
        console.warn('[AI Analyzer] ZAI SDK 초기화 실패 - AI 분석 비활성화:', error);
        this.initPromise = null;
        return null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Rate limiting 적용된 LLM 호출
   */
  private async callLLM(prompt: string): Promise<string | null> {
    const zai = await this.initialize();
    if (!zai) return null;

    // Rate limiting
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;
    if (timeSinceLastCall < this.MIN_CALL_INTERVAL_MS) {
      const waitMs = this.MIN_CALL_INTERVAL_MS - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    this.lastCallTime = Date.now();

    try {
      const completion = await zai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: '당신은 전문 주식 트레이더이자 퀀트 분석가입니다. 항상 JSON 형식으로만 응답하세요. 한국어로 응답하세요.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3, // 낮은 temperature로 일관된 분석
        max_tokens: 500,
      });

      const content = completion.choices?.[0]?.message?.content;
      if (!content) return null;

      return content;
    } catch (error) {
      console.warn('[AI Analyzer] LLM 호출 실패:', error);
      return null;
    }
  }

  /**
   * JSON 응답 파싱 (오류 허용)
   */
  private parseResponse(raw: string | null): AIAnalysisResult {
    if (!raw) return DEFAULT_AI_RESULT;

    try {
      // JSON 블록 추출 (마크다운 코드블록 포함 시)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return DEFAULT_AI_RESULT;

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        recommendation: ['BUY', 'SELL', 'HOLD'].includes(parsed.recommendation)
          ? parsed.recommendation : 'HOLD',
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(100, parsed.confidence)) : 0,
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        riskLevel: ['LOW', 'MEDIUM', 'HIGH'].includes(parsed.riskLevel)
          ? parsed.riskLevel : 'MEDIUM',
        warnings: Array.isArray(parsed.warnings)
          ? parsed.warnings.filter((w: unknown) => typeof w === 'string').slice(0, 5) : [],
        sentiment: ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(parsed.sentiment)
          ? parsed.sentiment : 'NEUTRAL',
      };
    } catch {
      console.warn('[AI Analyzer] JSON 파싱 실패:', raw.substring(0, 100));
      return DEFAULT_AI_RESULT;
    }
  }

  /**
   * 개별 종목 AI 분석
   * 기술적 분석 결과를 LLM이 검증/보강
   */
  async analyzeStock(
    stockName: string,
    stockCode: string,
    market: MarketType,
    technicalSignal: TradingSignal,
    marketContext?: string,
  ): Promise<AIAnalysisResult> {
    const prompt = buildAnalysisPrompt(stockName, stockCode, market, technicalSignal, marketContext);
    const raw = await this.callLLM(prompt);
    const result = this.parseResponse(raw);

    console.log(`[AI Analyzer] ${stockName} 분석 완료: ${result.recommendation} (신뢰도: ${result.confidence}%, 심리: ${result.sentiment})`);

    return result;
  }

  /**
   * 포트폴리오 전체 리스크 평가
   */
  async assessPortfolioRisk(
    positionsSummary: string,
    newSignal: TradingSignal,
  ): Promise<AIAnalysisResult> {
    const prompt = buildPortfolioRiskPrompt(positionsSummary, newSignal);
    const raw = await this.callLLM(prompt);
    return this.parseResponse(raw);
  }

  /**
   * 기술적 신호와 AI 분석을 결합하여 최종 신호 생성
   *
   * 결합 로직:
   * 1. 기술적 신호와 AI 추천이 같은 방향이면 → 신뢰도 상승 (+10~20%)
   * 2. 기술적 신호와 AI 추천이 다르면 → 신뢰도 하락 (-20~30%)
   * 3. AI가 HOLD이면 → 기술적 신호 신뢰도 50%로 제한
   * 4. AI 리스크가 HIGH이면 → 매수 신호 차단
   */
  combineSignals(
    technicalSignal: TradingSignal,
    aiResult: AIAnalysisResult,
  ): TradingSignal {
    // AI 분석을 사용할 수 없으면 기술적 신호 그대로 반환
    if (aiResult.confidence === 0) {
      return technicalSignal;
    }

    let combinedConfidence = technicalSignal.confidence;
    let combinedSignalType = technicalSignal.signalType;
    const reasons: string[] = [technicalSignal.reason];

    // AI와 기술적 신호 비교
    if (technicalSignal.signalType === aiResult.recommendation) {
      // 같은 방향 → 신뢰도 상승
      combinedConfidence = Math.min(95, combinedConfidence + 15);
      reasons.push(`AI 검증 동의 (심리: ${aiResult.sentiment})`);
    } else if (aiResult.recommendation === 'HOLD') {
      // AI가 HOLD → 신뢰도 하락
      combinedConfidence = Math.min(combinedConfidence, 45);
      reasons.push(`AI 보수적 판단: ${aiResult.summary}`);
    } else {
      // 다른 방향 → 신뢰도 하락
      combinedConfidence = Math.max(0, combinedConfidence - 25);
      reasons.push(`AI 이견 (${aiResult.recommendation}): ${aiResult.summary}`);

      // AI 신뢰도가 더 높으면 AI 방향으로 전환
      if (aiResult.confidence > technicalSignal.confidence + 20) {
        combinedSignalType = aiResult.recommendation;
        combinedConfidence = Math.floor(aiResult.confidence * 0.7);
        reasons.push(`AI 판단 우선 적용`);
      }
    }

    // HIGH 리스크 → 매수 차단
    if (aiResult.riskLevel === 'HIGH' && combinedSignalType === 'BUY') {
      combinedSignalType = 'HOLD';
      combinedConfidence = Math.min(combinedConfidence, 30);
      reasons.push(`AI 고위험 경고: ${aiResult.warnings.join(', ')}`);
    }

    // AI 경고 추가
    if (aiResult.warnings.length > 0) {
      reasons.push(`AI 경고: ${aiResult.warnings.join(', ')}`);
    }

    return {
      ...technicalSignal,
      signalType: combinedSignalType,
      confidence: Math.max(0, Math.min(95, combinedConfidence)),
      reason: reasons.join(' | '),
      indicators: {
        ...technicalSignal.indicators,
        aiSentiment: aiResult.sentiment === 'BULLISH' ? 1 : aiResult.sentiment === 'BEARISH' ? -1 : 0,
        aiRiskLevel: aiResult.riskLevel === 'LOW' ? 1 : aiResult.riskLevel === 'MEDIUM' ? 2 : 3,
        aiConfidence: aiResult.confidence,
      },
    };
  }
}

// 싱글톤 인스턴스
export const aiAnalyzer = new AIAnalyzer();
