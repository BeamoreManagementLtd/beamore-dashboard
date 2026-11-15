import { NextResponse, type NextRequest } from "next/server";
import { requireDirector, requireProfile } from "@/lib/auth";
import { googleAuthorizeUrl } from "@/lib/google";
import { userAuthorizeUrl } from "@/lib/google-user";

/**
 * Director: connects the dashboard's Google Drive and Gmail (?for= absent).
 * Anyone on the team (?for=me): connects their own Gmail, only to send reports they approve.
 */
export async function GET(request: NextRequest) {
  const forMe = request.nextUrl.searchParams.get("for") === "me";
  const me = forMe ? await requireProfile() : await requireDirector();
  const state = crypto.randomUUID();
  const redirect = `${request.nextUrl.origin}/api/google/callback`;
  const res = NextResponse.redirect(forMe ? userAuthorizeUrl(redirect, state, me.email) : googleAuthorizeUrl(redirect, state));
  res.cookies.set("google_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/google" });
  res.cookies.set("google_for", forMe ? "me" : "dashboard", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/google" });
  return res;
}
