"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: [string, string][] = [
  ["/portal", "Overview"],
  ["/portal/jobs", "Your jobs"],
  ["/portal/reports", "Your reports"],
  ["/portal/invoices", "Invoices"],
  ["/portal/insurance", "Insurance"],
  ["/portal/certificates", "Certificates & qualifications"],
  ["/portal/details", "My details"],
];

export function PortalNav() {
  const path = usePathname();
  return (
    <nav className="portal-tabs" aria-label="Portal sections">
      {TABS.map(([href, label]) => (
        <Link key={href} href={href} aria-current={path === href ? "page" : undefined}>{label}</Link>
      ))}
    </nav>
  );
}
