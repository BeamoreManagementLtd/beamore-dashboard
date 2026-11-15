import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Refreshes the Supabase session on every request and sends signed-out visitors to /login. */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        toSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const { data: { user } } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  const portalHost = (request.headers.get("host") ?? "").startsWith("portal.");
  if (portalHost && path === "/") {
    const url = request.nextUrl.clone();
    url.pathname = user ? "/portal" : "/login";
    return NextResponse.redirect(url);
  }
  const open = path.startsWith("/login") || path.startsWith("/auth") || path.startsWith("/api/sync") || path.startsWith("/api/reports") || path.startsWith("/join"); // api: they check the key themselves
  if (!user && !open) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = path === "/" ? "" : `?next=${encodeURIComponent(path + request.nextUrl.search)}`; // back there after signing in
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
