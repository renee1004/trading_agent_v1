// 해외(미국) 주식시장 시간 판단 로직
// ET(America/New_York) 기준으로 판단, 서머타임 자동 반영
// KST는 표시용으로만 사용, 내부 판단은 모두 ET 기준
//
// 핵심 원칙:
// - 한국은 미국보다 시간이 빠르다 (KST = ET + 13h/14h)
// - 미국 금요일 정규장이 한국에서는 토요일 새벽까지 이어짐
// - 따라서 KST 요일이 아니라 ET 요일로 장시간 판단해야 함
// - KST 토요일 00:27 = ET 금요일 11:27 → 해외장 OPEN

// =============================================
// ET 시간 계산 (서머타임 자동 반영)
// =============================================

/**
 * N번째 요일의 날짜 계산 (UTC 기준)
 * 미국 서머타임 시작/종료일 계산에 사용
 *
 * @param year 연도
 * @param month 월 (0=January, 11=December)
 * @param dayOfWeek 요일 (0=Sunday, 6=Saturday)
 * @param n N번째 (1=첫번째, 2=두번째, ...)
 */
function nthDayOfWeek(year: number, month: number, dayOfWeek: number, n: number): number {
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const firstDayOfWeek = firstOfMonth.getUTCDay();
  return 1 + ((dayOfWeek - firstDayOfWeek + 7) % 7) + (n - 1) * 7;
}

/**
 * 미국 서머타임(DST) 여부 판단
 *
 * 규칙:
 * - 시작: 3월 둘째 일요일 02:00 ET (07:00 UTC)
 * - 종료: 11월 첫째 일요일 02:00 ET (06:00 UTC)
 * - EDT (Daylight): UTC-4
 * - EST (Standard): UTC-5
 *
 * 2025~2030년 DST 전환일:
 * - 2025: 3/9 ~ 11/2
 * - 2026: 3/8 ~ 11/1
 * - 2027: 3/14 ~ 11/7
 * - 2028: 3/12 ~ 11/5
 * - 2029: 3/11 ~ 11/4
 * - 2030: 3/10 ~ 11/3
 */
export function isUSDST(): boolean {
  const now = new Date();
  const year = now.getUTCFullYear();

  // 2nd Sunday of March at 02:00 ET = 07:00 UTC
  const dstStartDate = nthDayOfWeek(year, 2, 0, 2); // March=2
  const dstStart = new Date(Date.UTC(year, 2, dstStartDate, 7, 0, 0));

  // 1st Sunday of November at 02:00 ET = 06:00 UTC
  const dstEndDate = nthDayOfWeek(year, 10, 0, 1); // November=10
  const dstEnd = new Date(Date.UTC(year, 10, dstEndDate, 6, 0, 0));

  return now >= dstStart && now < dstEnd;
}

/**
 * 현재 ET(Eastern Time) 시간 정보
 * 서머타임 자동 반영 (EDT: UTC-4, EST: UTC-5)
 *
 * 구현 방식:
 * 1. UTC 밀리초 계산 (서버 타임존 무관)
 * 2. ET 오프셋 적용 (DST에 따라 -4 또는 -5)
 * 3. 결과 Date에서 시간/요일 추출
 *
 * 이 방식은 서버가 UTC(Railway)이든 KST든 정확하게 동작함
 */
export function getETNow(): {
  hours: number;
  minutes: number;
  totalMinutes: number;
  dayOfWeek: number;   // 0=Sunday, 6=Saturday (ET 기준)
  year: number;
  month: number;       // 1~12
  day: number;
  dateStr: string;     // YYYY-MM-DD (ET 기준)
} {
  const now = new Date();
  // UTC 밀리초 = 로컬 시간 + 로컬 타임존 오프셋(분→ms)
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  // ET 오프셋: DST면 -4(EDT), 아니면 -5(EST)
  const etOffset = isUSDST() ? -4 : -5;
  const etMs = utcMs + etOffset * 3600000;
  const etDate = new Date(etMs);

  const hours = etDate.getHours();
  const minutes = etDate.getMinutes();

  return {
    hours,
    minutes,
    totalMinutes: hours * 60 + minutes,
    dayOfWeek: etDate.getDay(),
    year: etDate.getFullYear(),
    month: etDate.getMonth() + 1,
    day: etDate.getDate(),
    dateStr: `${etDate.getFullYear()}-${String(etDate.getMonth() + 1).padStart(2, '0')}-${String(etDate.getDate()).padStart(2, '0')}`,
  };
}

// =============================================
// 미국 공휴일 (ET 날짜 기준)
// =============================================

/**
 * 미국 공휴일 체크 (ET 날짜 기준)
 * NYSE/NASDAQ 휴장일
 *
 * 주의: KST 날짜가 아닌 ET 날짜로 판단해야 함
 * 예: KST 토요일 00:27 = ET 금요일 11:27 → ET 공휴일이 아니면 장열림
 *
 * 공휴일 종류:
 * 1. 고정 공휴일 (매년 같은 날짜)
 * 2. 이동 공휴일 (N번째 요일)
 * 3. Good Friday (부활절 금요일, 매년 날짜 다름)
 */
export function isUSHolidayET(
  etYear?: number,
  etMonth?: number,
  etDay?: number,
  etDayOfWeek?: number
): boolean {
  // 파라미터 없으면 현재 ET 날짜 사용
  if (etYear === undefined || etMonth === undefined || etDay === undefined || etDayOfWeek === undefined) {
    const et = getETNow();
    etYear = et.year;
    etMonth = et.month;
    etDay = et.day;
    etDayOfWeek = et.dayOfWeek;
  }

  const ymd = `${etYear}-${String(etMonth).padStart(2, '0')}-${String(etDay).padStart(2, '0')}`;

  // ── 고정 공휴일 ──
  if (etMonth === 1 && etDay === 1) return true;    // New Year's Day
  if (etMonth === 6 && etDay === 19) return true;    // Juneteenth
  if (etMonth === 7 && etDay === 4) return true;     // Independence Day
  if (etMonth === 11 && etDay === 11) return true;   // Veterans Day
  if (etMonth === 12 && etDay === 25) return true;   // Christmas Day

  // ── 이동 공휴일 (N번째 요일) ──
  // 3rd Monday of January - MLK Day
  if (etMonth === 1 && etDayOfWeek === 1 && Math.ceil(etDay / 7) === 3) return true;
  // 3rd Monday of February - Presidents' Day
  if (etMonth === 2 && etDayOfWeek === 1 && Math.ceil(etDay / 7) === 3) return true;
  // Last Monday of May - Memorial Day
  if (etMonth === 5 && etDayOfWeek === 1 && etDay + 7 > 31) return true;
  // 1st Monday of September - Labor Day
  if (etMonth === 9 && etDayOfWeek === 1 && etDay <= 7) return true;
  // 4th Thursday of November - Thanksgiving
  if (etMonth === 11 && etDayOfWeek === 4 && Math.ceil(etDay / 7) === 4) return true;

  // ── Good Friday (부활절 금요일) ──
  // 매년 날짜가 다르므로 2025~2030년 하드코딩
  const goodFridays: Record<number, string> = {
    2025: '2025-04-18',
    2026: '2026-04-03',
    2027: '2027-03-26',
    2028: '2028-04-14',
    2029: '2029-03-30',
    2030: '2030-04-19',
  };
  if (goodFridays[etYear] === ymd) return true;

  return false;
}

// =============================================
// 미국 정규장 개장 판단 (ET 기준)
// =============================================

/**
 * 미국 정규장 개장 여부 (ET 기준)
 *
 * 판단 순서:
 * 1. ET 평일 여부 (월~금)
 * 2. ET 공휴일 여부
 * 3. ET 시간 09:30~16:00
 *
 * 모든 판단을 ET 기준으로 수행하므로
 * KST 토요일이라도 ET 금요일 정규장 시간이면 OPEN
 */
export function isOverseasMarketOpen(): boolean {
  const et = getETNow();

  // ET 평일 체크 (0=일, 6=토)
  if (et.dayOfWeek === 0 || et.dayOfWeek === 6) return false;

  // ET 공휴일 체크
  if (isUSHolidayET(et.year, et.month, et.day, et.dayOfWeek)) return false;

  // ET 정규장 시간: 09:30~16:00
  const marketOpen = 9 * 60 + 30;   // 09:30 ET = 570분
  const marketClose = 16 * 60;      // 16:00 ET = 960분

  return et.totalMinutes >= marketOpen && et.totalMinutes < marketClose;
}

/**
 * 해외장 차단 사유 반환 (디버깅/로그용)
 */
export function getOverseasBlockedReason(): string {
  const et = getETNow();

  if (et.dayOfWeek === 0 || et.dayOfWeek === 6) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `ET 주말 (${dayNames[et.dayOfWeek]}, ${et.dateStr})`;
  }

  if (isUSHolidayET(et.year, et.month, et.day, et.dayOfWeek)) {
    return `ET 공휴일 (${et.dateStr})`;
  }

  if (et.totalMinutes < 9 * 60 + 30) {
    return `ET 장전 (${String(et.hours).padStart(2, '0')}:${String(et.minutes).padStart(2, '0')} ET, 개장 09:30 ET)`;
  }

  if (et.totalMinutes >= 16 * 60) {
    return `ET 장마감 (${String(et.hours).padStart(2, '0')}:${String(et.minutes).padStart(2, '0')} ET, 마감 16:00 ET)`;
  }

  return ''; // 장시간 (차단 없음)
}

// =============================================
// KST 표시용 시간 (서머타임 자동 반영)
// =============================================

/**
 * 서머타임에 따른 KST 표시 시간
 *
 * EDT (서머타임, UTC-4): KST = ET + 13h → 22:30~05:00 KST
 * EST (표준시, UTC-5):   KST = ET + 14h → 23:30~06:00 KST
 *
 * 예시:
 * - 서머타임: ET 09:30 = KST 22:30 (당일), ET 16:00 = KST 05:00 (익일)
 * - 표준시:   ET 09:30 = KST 23:30 (당일), ET 16:00 = KST 06:00 (익일)
 */
export function getOverseasMarketKSTDisplay(): {
  overseasMarketOpenKST: string;
  overseasMarketCloseKST: string;
  overseasSessionLabel: string;
} {
  const dst = isUSDST();
  if (dst) {
    return {
      overseasMarketOpenKST: '22:30',
      overseasMarketCloseKST: '05:00',
      overseasSessionLabel: '서울 기준 미국장 (서머타임): 22:30~05:00 KST',
    };
  } else {
    return {
      overseasMarketOpenKST: '23:30',
      overseasMarketCloseKST: '06:00',
      overseasSessionLabel: '서울 기준 미국장 (표준시): 23:30~06:00 KST',
    };
  }
}

/**
 * 현재 KST 시간 문자열 (표시용)
 * 형식: "HH:mi 요일" (예: "14:30 금요일")
 */
export function getCurrentKSTString(): string {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const kstMs = utcMs + 9 * 3600000;
  const kstDate = new Date(kstMs);
  const hours = kstDate.getHours();
  const minutes = kstDate.getMinutes();
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${dayNames[kstDate.getDay()]}요일`;
}

/**
 * 현재 ET 시간 문자열 (표시용)
 * 형식: "HH:mi DayOfWeek (EDT/EST)" (예: "11:27 Fri (EDT)")
 */
export function getCurrentETString(): string {
  const et = getETNow();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const tzLabel = isUSDST() ? 'EDT' : 'EST';
  return `${String(et.hours).padStart(2, '0')}:${String(et.minutes).padStart(2, '0')} ${dayNames[et.dayOfWeek]} (${tzLabel})`;
}

// =============================================
// 해외장 종합 정보 (status API용)
// =============================================

export interface OverseasMarketInfo {
  isOpen: boolean;
  currentET: string;
  currentKST: string;
  isDST: boolean;
  overseasMarketOpenKST: string;
  overseasMarketCloseKST: string;
  overseasSessionLabel: string;
  etDate: string;
  etDayOfWeek: number;
  blockedReason: string;
}

/**
 * 해외장 종합 정보 (ET 기준 + KST 표시)
 * /api/agent/status에서 사용
 */
export function getOverseasMarketInfo(): OverseasMarketInfo {
  const et = getETNow();
  const isOpen = isOverseasMarketOpen();
  const kstDisplay = getOverseasMarketKSTDisplay();
  const blockedReason = isOpen ? '' : getOverseasBlockedReason();

  return {
    isOpen,
    currentET: getCurrentETString(),
    currentKST: getCurrentKSTString(),
    isDST: isUSDST(),
    overseasMarketOpenKST: kstDisplay.overseasMarketOpenKST,
    overseasMarketCloseKST: kstDisplay.overseasMarketCloseKST,
    overseasSessionLabel: kstDisplay.overseasSessionLabel,
    etDate: et.dateStr,
    etDayOfWeek: et.dayOfWeek,
    blockedReason,
  };
}
