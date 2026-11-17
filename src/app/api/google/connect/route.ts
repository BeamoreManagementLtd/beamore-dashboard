import { NextResponse, type NextRequest } from "next/server";
import { requireDirector, requireProfile } from "@/lib/auth";
import { googleAuthorizeUrl } from "@/lib/google";
import { userAuthorizeUrl, AI_MAILBOX } from "@/lib/google-user";

/**
 * Director: connects the dashboard's Google Drive and Gmail (?for= absent).
 * Anyone on the team (?for=me): connects their own Gmail, only to send reports they approve.
 */
export async function GET(request: NextRequest) {
  const forWhat = request.nextUrl.searchParams.get("for");
  const forMe = forWhat === "me", forAi = forWhat === "ai";
  const me = forMe ? await requireProfile() : await requireDirector();
  const state = crypto.randomUUID();
  const redirect = `${request.nextUrl.origin}/api/google/callback`;
  // Director: the ai@beamore.co.uk mailbox the AI feedback emails go from (signed in as that account)
  const res = NextResponse.redirect(forMe ? userAuthorizeUrl(redirect, state, me.email) : forAi ? userAuthorizeUrl(redirect, state, AI_MAILBOX) : googleAuthorizeUrl(redirect, state));
  res.cookies.set("google_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/google" });
  res.cookies.set("google_for", forMe ? "me" : forAi ? "ai" : "dashboard", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/google" });
  return res;
}
