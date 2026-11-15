"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function SignInButton({ next }: { next?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await createClient().auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: `${window.location.origin}/auth/callback${next?.startsWith("/") && !next.startsWith("//") ? `?next=${encodeURIComponent(next)}` : ""}`,
            queryParams: { hd: "beamore.co.uk", prompt: "select_account" }, // only offer Beamore accounts
          },
        });
      }}
    >
      {busy ? "Opening Google…" : "Sign in with Google"}
    </button>
  );
}
