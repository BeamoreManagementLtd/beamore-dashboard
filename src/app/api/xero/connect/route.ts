import { NextResponse, type NextRequest } from "next/server";
import { requireDirector } from "@/lib/auth";
import { authorizeUrl } from "@/lib/xero";

/** Director only: sends the browser to Xero to approve read access for the dashboard. */
export async function GET(request: NextRequest) {
  await requireDirector();
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(authorizeUrl(`${request.nextUrl.origin}/api/xero/callback`, state));
  res.cookies.set("xero_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600, path: "/api/xero" });
  return res;
}
