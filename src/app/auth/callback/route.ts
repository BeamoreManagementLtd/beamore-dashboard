import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    const next = searchParams.get("next");
    const safe = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    if (!error) return NextResponse.redirect(`${origin}${safe}`);
  }
  // A non-Beamore account is refused by the database trigger, which lands here too.
  return NextResponse.redirect(`${origin}/login?error=not-staff`);
}
