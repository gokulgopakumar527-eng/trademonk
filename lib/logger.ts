/**
 * Minimal structured JSON logger with secret redaction.
 * One line of JSON per event so Vercel/Datadog/Sentry breadcrumbs can parse it.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY =
  /pass(word)?|secret|token|api[_-]?key|authorization|cookie|service[_-]?role|credential/i;
const REDACTED = "[REDACTED]";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

function minLevel(): Level {
  const configured = process.env.LOG_LEVEL as Level | undefined;
  return configured && configured in ORDER ? configured : "info";
}

function emit(level: Level, event: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[minLevel()]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    event,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
