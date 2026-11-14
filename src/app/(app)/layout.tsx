import Link from "next/link";
import { requireProfile } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await requireProfile();
  const director = me.role === "director";
  const nav: [string, string][] = [
    ["/", "Home"],
    ["/due", "Due list"],
    ["/projects", "Projects"],
    ["/invoices", "Overdue invoices"],
    ["/reports", "Reports"],
    ["/personnel", "Personnel"],
    ["/signoff", "Month sign-off"],
    ...(director ? ([["/finance", "Finance"]] as [string, string][]) : []),
  ];
  return (
    <div className="shell">
      <aside className="side">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <Link href="/" className="brand"><img src="/beamore-logo.jpg" alt="Beamore" /><span><b>Beamore</b><small>Management</small></span></Link>
        <nav className="nav">
          {nav.map(([href, label]) => (
            <Link key={href} href={href}>{label}{label === "Finance" && <span className="ronly">Director</span>}</Link>
          ))}
        </nav>
        <div className="me">
          {me.full_name ?? me.email}
          <br />
          {director ? "Director" : "Admin"} ·{" "}
          <form action="/auth/signout" method="post" style={{ display: "inline" }}>
            <button className="btn" style={{ padding: "2px 8px", fontSize: 12 }}>Sign out</button>
          </form>
        </div>
      </aside>
      <main className="work">{children}</main>
    </div>
  );
}
