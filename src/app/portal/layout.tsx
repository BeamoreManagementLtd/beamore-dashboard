import Link from "next/link";
import { requirePortalUser } from "@/lib/portal/auth";
import { PortalNav } from "./portal-nav";
import { viewAs } from "./actions";

export const metadata = { title: "Beamore portal" };

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const me = await requirePortalUser();
  const name = me.clerk?.name ?? me.staff?.name ?? me.email;
  return (
    <div className="portal">
      <header className="portal-top">
        <Link href="/portal" className="brand">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/beamore-logo.jpg" alt="Beamore" /><span><b>Beamore</b><small>Portal</small></span>
        </Link>
        <div className="portal-me">
          <span>{name}</span>
          {me.staff && <Link href="/clerk-portal" className="btn">Admin</Link>}
          <form action="/auth/signout" method="post"><button className="btn">Sign out</button></form>
        </div>
      </header>
      {me.viewingAs && (
        <form action={viewAs} className="viewas"><span>Viewing as <b>{me.clerk?.name}</b> (what they see; anything you upload goes in for them, from the office)</span><button className="btn">Stop</button></form>
      )}
      {me.clerk && <PortalNav />}
      <main className="portal-main">{children}</main>
      <footer className="portal-foot muted small">Beamore Management Ltd · Questions? Email <a href="mailto:ronan@beamore.co.uk">ronan@beamore.co.uk</a></footer>
    </div>
  );
}
