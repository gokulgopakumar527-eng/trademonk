import { z } from "zod";

/**
 * NSE/BSE equity-segment timing rules (IST, no DST).
 * Verified against exchange timing circulars as republished by multiple sources on 2026-09-28:
 *   pre-open 09:00-09:15, regular 09:15-15:30, closing session 15:40-16:00.
 * The closing session is treated as CLOSED for continuous trading. RE-VERIFY against the
 * exchange's own circular before launch; exchanges can change timings by circular.
 */
export const INDIA_EQUITY_SESSION = {
  timeZone: "Asia/Kolkata",
  utcOffsetMinutes: 330,
  preOpenStartMin: 9 * 60,
  openMin: 9 * 60 + 15,
  closeMin: 15 * 60 + 30,
  verifiedOn: "2026-09-28",
  sourceNote: "NSE/BSE equity timing circulars (secondary republication); confirm at nseindia.com / bseindia.com",
} as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * Holiday calendar file shape (config/market-calendars/india-holidays.json).
 * TradeMonk does NOT ship holiday dates that have not been verified against the official
 * exchange circular. Populate `years` from the circular and set `verified` to true.
 */
export const holidayCalendarSchema = z.object({
  verified: z.boolean(),
  sourceUrl: z.string().nullable(),
  verifiedOn: isoDate.nullable(),
  /** Years fully covered by `holidays` (so a missing date in a covered year really means "trading day"). */
  coveredYears: z.array(z.number().int()),
  holidays: z.array(z.object({ date: isoDate, description: z.string() })),
  /** Special sessions (e.g. Diwali Muhurat) that trade on otherwise closed days. Times IST "HH:MM". */
  specialSessions: z.array(
    z.object({
      date: isoDate,
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      description: z.string(),
    }),
  ),
});
export type IndiaHolidayCalendar = z.infer<typeof holidayCalendarSchema>;

export const EMPTY_INDIA_CALENDAR: IndiaHolidayCalendar = {
  verified: false,
  sourceUrl: null,
  verifiedOn: null,
  coveredYears: [],
  holidays: [],
  specialSessions: [],
};
