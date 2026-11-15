import { NextResponse, type NextRequest } from "next/server";
import { requireDirector, requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { connectGoogle } from "@/lib/google";
import { connectUserGoogle } from "@/lib/google-user";
import { syncDiary } from "@/lib/sync/diary-sync";

export const maxDuration = 120;

/** Google sends people back here: the director's dashboard connection, or a team member's own email for sending reports. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const stateOk = searchParams.get("state") === request.cookies.get("google_state")?.value;
  const done = (res: NextResponse) => { res.cookies.delete({ name: "google_state", path: "/api/google" }); res.cookies.delete({ name: "google_for", path: "/api/google" }); return res; };

  if (request.cookies.get("google_for")?.value === "me") {
    const me = await requireProfile();
    const back = (q: string) => done(NextResponse.redirect(`${origin}/reports/settings?${q}`));
    if (searchParams.get("error") || !code) return back(`email=error&reason=${encodeURIComponent(searchParams.get("error") ?? "no code")}`);
    if (!stateOk) return back("email=error&reason=state");
    try {
      const email = await connectUserGoogle(createServiceClient(), me.id, code, `${origin}/api/google/callback`);
      return back(`email=connected&as=${encodeURIComponent(email)}`);
    } catch (e) {
      return back(`email=error&reason=${encodeURIComponent(e instanceof Error ? e.message : "connect failed")}`);
    }
  }

  const me = await requireDirector();
  const back = (q: string) => done(NextResponse.redirect(`${origin}/finance?${q}`));
  if (searchParams.get("error") || !code) return back(`diary=error&reason=${encodeURIComponent(searchParams.get("error") ?? "no code")}`);
  if (!stateOk) return back("diary=error&reason=state");
  const admin = createServiceClient();
  try {
    await connectGoogle(admin, code, `${origin}/api/google/callback`, me.id);
  } catch (e) {
    return back(`diary=error&reason=${encodeURIComponent(e instanceof Error ? e.message : "connect failed")}`);
  }
  const r = await syncDiary(admin, { force: true });
  return back(r.ok ? "diary=connected" : `diary=error&reason=${encodeURIComponent(r.message)}`);
}
