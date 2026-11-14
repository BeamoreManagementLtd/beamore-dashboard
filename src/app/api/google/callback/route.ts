import { NextResponse, type NextRequest } from "next/server";
import { requireDirector } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { connectGoogle } from "@/lib/google";
import { syncDiary } from "@/lib/sync/diary-sync";

export const maxDuration = 120;

/** Google sends the director back here; saves the connection and reads the diary for the first time. */
export async function GET(request: NextRequest) {
  const me = await requireDirector();
  const { searchParams, origin } = request.nextUrl;
  const back = (q: string) => NextResponse.redirect(`${origin}/finance?${q}`);
  const code = searchParams.get("code");
  if (searchParams.get("error") || !code) return back(`diary=error&reason=${encodeURIComponent(searchParams.get("error") ?? "no code")}`);
  if (searchParams.get("state") !== request.cookies.get("google_state")?.value) return back("diary=error&reason=state");
  const admin = createServiceClient();
  try {
    await connectGoogle(admin, code, `${origin}/api/google/callback`, me.id);
  } catch (e) {
    return back(`diary=error&reason=${encodeURIComponent(e instanceof Error ? e.message : "connect failed")}`);
  }
  const r = await syncDiary(admin, { force: true });
  const res = back(r.ok ? "diary=connected" : `diary=error&reason=${encodeURIComponent(r.message)}`);
  res.cookies.delete({ name: "google_state", path: "/api/google" });
  return res;
}
