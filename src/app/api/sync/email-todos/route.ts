import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runEmailTodos } from "@/lib/sync/email-todos";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Every 30 minutes (vercel.json): Ronan's new email -> to-dos on Todoist and the dashboard. ?trial=1&hours=N looks without changing anything. */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`)
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const u = request.nextUrl.searchParams;
  const r = await runEmailTodos(createServiceClient(), { dryRun: u.get("trial") === "1", hours: Number(u.get("hours")) || undefined });
  return NextResponse.json(r, { status: r.ok ? 200 : 500 });
}
