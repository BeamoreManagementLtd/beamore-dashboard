import { NextResponse, type NextRequest } from "next/server";
import { requireDirector } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { connect } from "@/lib/xero";
import { syncXero } from "@/lib/sync/xero-sync";

export const maxDuration = 60;

/** Xero sends the director back here after approving. Saves the connection, then runs the first sync. */
export async function GET(request: NextRequest) {
  const me = await requireDirector();
  const { searchParams, origin } = request.nextUrl;
  const back = (q: string) => NextResponse.redirect(`${origin}/finance?${q}`);
  const code = searchParams.get("code");
  if (searchParams.get("error") || !code) return back(`xero=error&reason=${encodeURIComponent(searchParams.get("error") ?? "no code")}`);
  if (!searchParams.get("state") || searchParams.get("state") !== request.cookies.get("xero_state")?.value) return back("xero=error&reason=state");

  const admin = createServiceClient();
  try {
    await connect(admin, code, `${origin}/api/xero/callback`, me.id);
  } catch (e) {
    return back(`xero=error&reason=${encodeURIComponent(e instanceof Error ? e.message : "connect failed")}`);
  }
  const r = await syncXero(admin);
  const res = back(r.ok ? "xero=connected" : `xero=error&reason=${encodeURIComponent(r.message)}`);
  res.cookies.delete({ name: "xero_state", path: "/api/xero" });
  return res;
}
