import raw from "@/config/market-calendars/india-holidays.json";
import {
  EMPTY_INDIA_CALENDAR,
  holidayCalendarSchema,
  type IndiaHolidayCalendar,
} from "@/config/market-calendars/india";
import { logger } from "@/lib/logger";

/** Parse the holiday file. A malformed file degrades to the empty (unverified) calendar, never to guessed dates. */
export function loadIndiaCalendar(source: unknown = raw): IndiaHolidayCalendar {
  const parsed = holidayCalendarSchema.safeParse(source);
  if (!parsed.success) {
    logger.error("market_calendar.invalid", { issues: parsed.error.issues.length });
    return EMPTY_INDIA_CALENDAR;
  }
  // "verified" without a source or date is not trusted.
  if (parsed.data.verified && (!parsed.data.sourceUrl || !parsed.data.verifiedOn)) {
    logger.warn("market_calendar.unverifiable", {});
    return { ...parsed.data, verified: false };
  }
  return parsed.data;
}
