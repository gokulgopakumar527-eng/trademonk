import { NextResponse } from "next/server";

/** Liveness only. Does not touch the database or expose configuration. */
export function GET() {
  return NextResponse.json({ status: "ok", time: new Date().toISOString() });
}
