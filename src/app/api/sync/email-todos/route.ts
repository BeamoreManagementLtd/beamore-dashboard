import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runEmailTodos } from "@/lib/sync/email-todos";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * 08:00, 12:00 and 18:00 UK time, every day (Ronan, 16 Nov 2026). Vercel runs on UTC, so the cron fires at both
 * possible UTC hours and only the one that is 8, 12 or 18 in London goes ahead. ?trial=1&hours=N looks without
 * changing anything; ?now=1 runs straight away.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const u = request.nextUrl.searchParams;
  const ukHour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/London" }).format(new Date()));
  if (!u.get("trial") && !u.get("now") && ![8, 12, 18].includes(ukHour)) return NextResponse.json({ ok: true, message: `not a run time (${ukHour}:00 UK)` });
  const r = await runEmailTodos(createServiceClient(), { dryRun: u.get("trial") === "1", hours: Number(u.get("hours")) || undefined });
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
