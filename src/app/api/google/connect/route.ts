import { NextResponse, type NextRequest } from "next/server";
import { requireDirector } from "@/lib/auth";
import { googleAuthorizeUrl } from "@/lib/google";

/** Director only: asks Google for read-only Drive access so the dashboard can read the diary. */
export async function GET(request: NextRequest) {
  await requireDirector();
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(googleAuthorizeUrl(`${request.nextUrl.origin}/api/google/callback`, state));
  res.cookies.set("google_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/google" });
  return res;
}
