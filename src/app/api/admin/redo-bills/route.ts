import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { makeBill } from "@/lib/portal/xero-bills";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Rebuilds the draft bills already made from clerks' invoices so each has one line per project (project name, visits,
 * day rate, tracking code) (Ronan, 27 Nov 2026: "We haven't separated them out by project... Change it all").
 * Only DRAFT bills are touched. GET ?dry=1 shows the lines without changing anything; ?from=0&count=8 does a batch.
 * Bearer CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  const admin = createServiceClient();
  const sp = req.nextUrl.searchParams;
  const dry = sp.get("dry") === "1", from = Number(sp.get("from") ?? 0), count = Math.min(Number(sp.get("count") ?? 8), 15);
  const { data } = await admin.from("portal_uploads").select("id,ai_result,clerks(name)").in("kind", ["invoice", "company_invoice"])
    .eq("ai_result->xero->>state", "created").order("received_at").range(from, from + count - 1);
  const out = [];
  for (const u of data ?? []) {
    const o = await makeBill(admin, u.id, { redo: true, dry }).catch((e) => ({ state: "error", note: e instanceof Error ? e.message : String(e) }) as const);
    if (!dry && o.state === "created") {
      const { data: cur } = await admin.from("portal_uploads").select("ai_result").eq("id", u.id).single();
      await admin.from("portal_uploads").update({ ai_result: { ...((cur?.ai_result ?? {}) as object), xero: { ...o, at: new Date().toISOString() } } }).eq("id", u.id);
    }
    out.push({ clerk: (u.clerks as unknown as { name: string } | null)?.name, ...o });
  }
  return NextResponse.json({ from, count: out.length, results: out });
}
