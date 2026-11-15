import { SignInButton } from "./sign-in-button";

export const metadata = { title: "Sign in · Beamore" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  const portal = next?.startsWith("/portal");
  return (
    <main className="login">
      <div className="login-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <div className="brand"><img src="/beamore-logo.jpg" alt="Beamore" /><span><b>Beamore</b><small>Management</small></span></div>
        <h1>{portal ? "Beamore portal" : "Sign in"}</h1>
        <p className="muted">Use your Beamore Google account.</p>
        {error && (
          <p className="callout bad">
            {error === "not-staff" ? "Use your @beamore.co.uk Google account." : error === "no-portal" ? "Your account doesn't have portal access yet. Please contact Beamore." : "Sign-in didn't complete. Try again."}
          </p>
        )}
        <SignInButton next={next} />
      </div>
    </main>
  );
}
