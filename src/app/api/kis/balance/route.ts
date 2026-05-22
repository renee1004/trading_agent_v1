// 계좌 잔고 조회 라우트

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { KisApiClient } from '@/lib/kis-api';

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstSummary(output2: unknown): Record<string, string> {
  if (Array.isArray(output2)) return (output2[0] || {}) as Record<string, string>;
  return (output2 || {}) as Record<string, string>;
}

export async function GET() {
  try {
    const config = await db.kisConfig.findFirst();

    if (config?.accessToken) {
      try {
        const baseUrl = config.isDemo
          ? 'https://openapivts.koreainvestment.com:29443'
          : 'https://openapi.koreainvestment.com:9443';

        const params = new URLSearchParams({
          CANO: config.accountNo.substring(0, 8),
          ACNT_PRDT_CD: config.accountNo.substring(8).replace('-', '') || '01',
          AFHR_FLPR_YN: 'N',
          OFL_YN: '',
          INQR_DVSN: '02',
          UNPR_DVSN: '01',
          FUND_STTL_ICLD_YN: 'N',
          FNCG_AMT_AUTO_RDPT_YN: 'N',
          PRCS_DVSN: '00',
          CTX_AREA_FK100: '',
          CTX_AREA_NK100: '',
        });

        const trId = config.isDemo ? 'VTTC8434R' : 'TTTC8434R';
        const response = await fetch(`${baseUrl}/uapi/domestic-stock/v1/trading/inquire-balance?${params.toString()}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.accessToken}`,
            appKey: config.appKey,
            appSecret: config.appSecret,
            tr_id: trId,
          },
        });

        if (!response.ok) {
          throw new Error(`KIS balance HTTP ${response.status}`);
        }

        const result = await response.json();
        if (result.rt_cd !== '0') {
          throw new Error(result.msg1 || 'KIS 잔고 조회 실패');
        }

        // KIS 국내 잔고 API: output1 = 보유종목 목록, output2 = 계좌 요약
        const holdings = Array.isArray(result.output1) ? result.output1 : [];
        const summary = firstSummary(result.output2);

        const positions = holdings
          .filter((item: Record<string, string>) => toNumber(item.hldg_qty) > 0)
          .map((item: Record<string, string>) => ({
            stockCode: item.pdno || '',
            stockName: item.prdt_name || item.prdt_abrv_name || '',
            quantity: toNumber(item.hldg_qty),
            avgPrice: toNumber(item.pchs_avg_pric),
            currentPrice: toNumber(item.prpr || item.stck_prpr),
            profitLoss: toNumber(item.evlu_pfls_amt),
            profitRate: toNumber(item.evlu_pfls_rt),
            evaluationAmount: toNumber(item.evlu_amt),
            market: 'DOMESTIC',
            currency: 'KRW',
          }));

        const stockEvaluation = toNumber(summary.scts_evlu_amt);
        const totalEvaluation =
          toNumber(summary.tot_evlu_amt) ||
          toNumber(summary.nass_amt) ||
          stockEvaluation + toNumber(summary.dnca_tot_amt);
        const totalProfitLoss =
          toNumber(summary.evlu_pfls_smtl_amt) ||
          toNumber(summary.tot_pfls);
        const purchaseAmount = toNumber(summary.pchs_amt_smtl_amt);
        const totalProfitRate = purchaseAmount > 0 ? (totalProfitLoss / purchaseAmount) * 100 : toNumber(summary.tot_pfls_rt);
        const availableAmount =
          toNumber(summary.prvs_rcdl_excc_amt) ||
          toNumber(summary.dnca_tot_amt) ||
          toNumber(summary.nxdy_excc_amt);

        const balance = {
          // 기존 화면이 totalDeposit을 총자산 카드에 사용하고 있어서 총평가자산을 넣어 호환 유지
          totalDeposit: totalEvaluation,
          totalEvaluation,
          totalProfitLoss,
          totalProfitRate,
          availableAmount,
          cashAmount: toNumber(summary.dnca_tot_amt),
          stockEvaluation,
          positions,
        };

        console.log('[KIS Balance] API success', {
          totalEvaluation: balance.totalEvaluation,
          cashAmount: balance.cashAmount,
          stockEvaluation: balance.stockEvaluation,
          positions: balance.positions.length,
        });

        return NextResponse.json({ success: true, data: balance, source: 'api' });
      } catch (apiError: any) {
        console.error('[KIS Balance] API failed:', apiError.message || apiError);
        return NextResponse.json(
          { success: false, error: apiError.message || 'KIS 잔고 조회 실패', source: 'api' },
          { status: 502 }
        );
      }
    }

    const client = null as KisApiClient | null;
    void client;
    return NextResponse.json(
      { success: false, error: 'KIS access token이 없습니다. API 설정에서 토큰을 발급해주세요.', source: 'none' },
      { status: 400 }
    );
  } catch (error) {
    console.error('[KIS Balance] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: '잔고 조회 실패' },
      { status: 500 }
    );
  }
}
