import { NextResponse } from 'next/server';
import { getOrCreateKisConfigFromEnv } from '@/lib/kis-config-loader';
import { KisApiClient } from '@/lib/kis-api';

/**
 * 임시 진단 엔드포인트: 국내 일봉 FID 필드명 테스트
 * FID_ORIG_ADJ_PRC vs FID_ORG_ADJ_PRC 실제 KIS API 응답 비교
 * 운영 코드에 반영 후 삭제 예정
 */
export async function GET() {
  const results: Record<string, unknown>[] = [];

  try {
    const kisConfig = await getOrCreateKisConfigFromEnv();
    if (!kisConfig) {
      return NextResponse.json({ error: 'KIS 설정 없음' }, { status: 500 });
    }

    const kisClient = new KisApiClient(kisConfig);
    const token = await kisClient.ensureToken();

    const DEMO_BASE_URL = 'https://openapivts.koreainvestment.com:29443';
    const REAL_BASE_URL = 'https://openapi.koreainvestment.com:9443';

    const testStockCode = '005930'; // 삼성전자
    const testFieldNames = ['FID_ORIG_ADJ_PRC', 'FID_ORG_ADJ_PRC'];

    // 날짜 범위 (3개월)
    const end = new Date();
    const start = new Date();
    start.setMonth(start.getMonth() - 1);
    const formatYmd = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}${m}${day}`;
    };
    const startDate = formatYmd(start);
    const endDate = formatYmd(end);

    const baseUrls = kisConfig.isDemo
      ? [DEMO_BASE_URL, REAL_BASE_URL]
      : [REAL_BASE_URL];

    for (const fieldName of testFieldNames) {
      for (const baseUrl of baseUrls) {
        const url = `${baseUrl}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice`;

        const params = new URLSearchParams({
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_INPUT_ISCD: testStockCode,
          FID_INPUT_DATE_1: startDate,
          FID_INPUT_DATE_2: endDate,
          FID_PERIOD_DIV_CODE: 'D',
          [fieldName]: '1',
        });

        const requestParamKeys = Array.from(params.keys());

        try {
          const response = await fetch(`${url}?${params.toString()}`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              appKey: kisConfig.appKey,
              appSecret: kisConfig.appSecret,
              tr_id: 'FHKST03010100',
            },
          });

          const httpStatus = response.status;
          let rt_cd = '';
          let msg_cd = '';
          let msg1 = '';
          let output2Length = 0;

          if (response.ok) {
            try {
              const result = await response.json();
              rt_cd = result.rt_cd || '';
              msg_cd = result.msg_cd || '';
              msg1 = result.msg1 || '';
              output2Length = Array.isArray(result.output2) ? result.output2.length : 0;
            } catch {
              msg1 = 'JSON parse error';
            }
          } else {
            try {
              const errText = await response.text();
              msg1 = errText.substring(0, 200);
            } catch {
              msg1 = `HTTP ${httpStatus}`;
            }
          }

          const testResult = {
            stockCode: testStockCode,
            baseUrl,
            testedFieldName: fieldName,
            requestParamKeys,
            httpStatus,
            rt_cd,
            msg_cd,
            msg1: msg1.substring(0, 200),
            output2Length,
            success: httpStatus === 200 && rt_cd === '0' && output2Length > 0,
          };

          results.push(testResult);

          console.log('[FID TEST]', JSON.stringify(testResult));
        } catch (error) {
          const testResult = {
            stockCode: testStockCode,
            baseUrl,
            testedFieldName: fieldName,
            requestParamKeys,
            httpStatus: 0,
            rt_cd: '',
            msg_cd: '',
            msg1: error instanceof Error ? error.message : String(error),
            output2Length: 0,
            success: false,
          };
          results.push(testResult);
          console.log('[FID TEST]', JSON.stringify(testResult));
        }
      }
    }

    // 결과 요약
    const summary = {
      testStockCode,
      results,
      successfulFields: results.filter(r => r.success).map(r => ({
        fieldName: r.testedFieldName,
        baseUrl: r.baseUrl,
        output2Length: r.output2Length,
      })),
      failedFields: results.filter(r => !r.success).map(r => ({
        fieldName: r.testedFieldName,
        baseUrl: r.baseUrl,
        httpStatus: r.httpStatus,
        msg_cd: r.msg_cd,
        msg1: r.msg1,
      })),
      recommendation: '',
    };

    // 권장 필드 결정
    const origSuccess = results.find(r => r.testedFieldName === 'FID_ORIG_ADJ_PRC' && r.success);
    const orgSuccess = results.find(r => r.testedFieldName === 'FID_ORG_ADJ_PRC' && r.success);

    if (origSuccess && !orgSuccess) {
      summary.recommendation = 'FID_ORIG_ADJ_PRC (유일 성공)';
    } else if (orgSuccess && !origSuccess) {
      summary.recommendation = 'FID_ORG_ADJ_PRC (유일 성공)';
    } else if (origSuccess && orgSuccess) {
      summary.recommendation = '둘 다 성공 - 공식 문서 기준 선택 필요';
    } else {
      summary.recommendation = '둘 다 실패 - KIS API 정책 변경 가능성';
    }

    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      results,
    }, { status: 500 });
  }
}
