import type { Market } from "@/types/domain";
import type { MarketState, MarketStatus } from "@/types/market";
import {
  INDIA_EQUITY_SESSION as S,
  type IndiaHolidayCalendar,
} from "@/config/market-calendars/india";

interface IstParts {
  date: string; // YYYY-MM-DD in IST
  year: number;
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since IST midnight
}

export function istParts(at: Date): IstParts {
  const shifted = new Date(at.getTime() + S.utcOffsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return {
    date: `${y}-${m}-${d}`,
    year: y,
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** UTC instant for a given IST date + minute-of-day. */
function istInstant(date: string, minute: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 0, minute - S.utcOffsetMinutes));
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

interface DayKind {
  kind: "TRADING" | "WEEKEND" | "HOLIDAY";
  special?: { start: number; end: number };
  holidayNote?: string;
}

function dayKind(date: string, weekday: number, cal: IndiaHolidayCalendar): DayKind {
  const special = cal.specialSessions.find((s) => s.date === date);
  const specialWin = special ? { start: toMin(special.start), end: toMin(special.end) } : undefined;
  const holiday = cal.holidays.find((h) => h.date === date);
  if (holiday) return { kind: "HOLIDAY", special: specialWin, holidayNote: holiday.description };
  if (weekday === 0 || weekday === 6) return { kind: "WEEKEND", special: specialWin };
  return { kind: "TRADING", special: specialWin };
}

function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** Next scheduled state transition strictly after `at`. Searches up to 14 days ahead. */
function nextChange(at: Date, cal: IndiaHolidayCalendar): Date | null {
  const now = istParts(at);
  for (let i = 0; i < 14; i++) {
    const date = addDays(now.date, i);
    const dk = dayKind(date, weekdayOf(date), cal);
    const edges: number[] = [];
    if (dk.kind === "TRADING") edges.push(S.preOpenStartMin, S.openMin, S.closeMin);
    if (dk.special) edges.push(dk.special.start, dk.special.end);
    for (const e of edges.sort((a, b) => a - b)) {
      const inst = istInstant(date, e);
      if (inst.getTime() > at.getTime()) return inst;
    }
  }
  return null;
}

/**
 * Pure status computation for NSE/BSE equity segment. `basis` is CALENDAR only when a verified
 * holiday calendar covers the current year; otherwise SCHEDULE_ONLY and callers/UI must say that
 * an "open" reading may be wrong on an unlisted trading holiday.
 */
export function computeIndiaMarketStatus(
  market: Market,
  at: Date,
  cal: IndiaHolidayCalendar,
  source: string,
): MarketStatus {
  const p = istParts(at);
  const calendarUsable = cal.verified && cal.coveredYears.includes(p.year);
  const dk = dayKind(p.date, p.weekday, cal);

  let state: MarketState;
  let note: string | null = null;

  if (dk.special && p.minutes >= dk.special.start && p.minutes < dk.special.end) {
    state = "OPEN";
    note = "Special exchange session.";
  } else if (dk.kind === "HOLIDAY") {
    state = "HOLIDAY";
    note = dk.holidayNote ?? "Exchange holiday.";
  } else if (dk.kind === "WEEKEND") {
    state = "CLOSED";
    note = "Weekend.";
  } else if (p.minutes >= S.openMin && p.minutes < S.closeMin) {
    state = "OPEN";
  } else if (p.minutes >= S.preOpenStartMin && p.minutes < S.openMin) {
    state = "PRE_OPEN";
  } else {
    state = "CLOSED";
  }

  if (!calendarUsable) {
    const caveat = "Holiday calendar not loaded/verified: status follows the regular weekday schedule only.";
    note = note ? `${note} ${caveat}` : caveat;
  }

  const next = nextChange(at, cal);
  const iso = at.toISOString();
  return {
    source,
    asOf: iso,
    fetchedAt: iso,
    isMock: false,
    market,
    state,
    basis: calendarUsable ? "CALENDAR" : "SCHEDULE_ONLY",
    nextChangeAt: next ? next.toISOString() : null,
    note,
  };
}
