import { SignInButton } from "./sign-in-button";

export const metadata = { title: "Sign in · Beamore" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <main className="login">
      <div className="login-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <div className="brand"><img src="/beamore-logo.jpg" alt="Beamore" /><span><b>Beamore</b><small>Management</small></span></div>
        <h1>Sign in</h1>
        <p className="muted">Use your Beamore Google account.</p>
        {error && (
          <p className="callout bad">
            {error === "not-staff" ? "That account isn't set up for the dashboard. Use your @beamore.co.uk account." : "Sign-in didn't complete. Try again."}
          </p>
        )}
        <SignInButton />
      </div>
    </main>
  );
}
