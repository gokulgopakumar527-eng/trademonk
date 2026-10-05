import { z } from "zod";
import { MARKETS } from "@/types/domain";

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1, "Enter your name").max(80),
  timezone: z.string().refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid timezone"),
  preferred_currency: z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code, e.g. INR"),
  preferred_markets: z.array(z.enum(MARKETS)).max(MARKETS.length),
});

export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
