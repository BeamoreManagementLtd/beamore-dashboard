import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { findPerson, LIST_LABEL } from "@/lib/distribution";
import { replaceEverywhere } from "../lists-actions";

export const dynamic = "force-dynamic";

const STAGE: Record<string, string> = { live: "Live", won_arranging: "Starting", won_preparing: "Starting", on_hold: "On hold", complete: "Finished", lost: "Lost", enquiry: "Quote", sent: "Quote", pricing: "Pricing" };
const RUNNING = ["live", "won_arranging", "won_preparing", "on_hold"];

/** When a project manager leaves: find every project they're on, then take them off or put their replacement in. */
export default async function EmailListsPage({ searchParams }: { searchParams: Promise<{ q?: string; done?: string; error?: string }> }) {
  await requireProfile();
  const { q, done, error } = await searchParams;
  const db = await createClient();
  const hits = q ? await findPerson(db, q) : [];
  return (
    <main className="page">
      <p className="small"><Link href="/projects">Projects</Link></p>
      <h1>Email lists</h1>
      <p className="muted">Someone has left a project or a company? Find every project they get reports or invoices for, take them off, or put their replacement in the same place. Each project&apos;s own lists can also be changed on its page.</p>
      {done && <p className="callout good">Done: {done} project{done === "1" ? "" : "s"} changed. The diary&apos;s Projects tab is updated as soon as nobody has had it open for 10 minutes.</p>}
      {error && <p className="callout bad">{error}</p>}
      <form className="row" style={{ gap: 8, margin: "12px 0" }}>
        <input name="q" defaultValue={q ?? ""} placeholder="Their email address, or part of it (e.g. gemma.barr)" style={{ minWidth: 340 }} />
        <button className="btn primary">Find</button>
      </form>
      {q && !hits.length && <p className="muted">Nobody matching &ldquo;{q}&rdquo; is on any project&apos;s lists.</p>}
      {!!hits.length && (
        <form action={replaceEverywhere}>
          <input type="hidden" name="old" value={hits.length ? (hits[0].lists[hits[0].on[0]].find((e) => e.toLowerCase().includes(q!.toLowerCase())) ?? q) : q} />
          <p className="small muted">On {hits.length} project{hits.length === 1 ? "" : "s"}. Finished jobs are unticked; tick the ones to change.</p>
          <table>
            <thead><tr><th style={{ width: 30 }} /><th>Project</th><th>Status</th><th>On</th><th>Everyone else on those lists</th></tr></thead>
            <tbody>{hits.map((h) => (
              <tr key={h.id}>
                <td><input type="checkbox" name="project" value={h.id} defaultChecked={RUNNING.includes(h.stage)} aria-label={`Change ${h.name}`} /></td>
                <td><Link href={`/projects/${h.id}`}>{h.name}</Link> <span className="muted small">{h.number}</span></td>
                <td className="small">{STAGE[h.stage] ?? h.stage}</td>
                <td className="small">{h.on.map((k) => LIST_LABEL[k]).join(", ")}</td>
                <td className="small muted">{[...new Set(h.on.flatMap((k) => h.lists[k]))].filter((e) => !e.toLowerCase().includes(q!.toLowerCase())).join("; ") || "Nobody"}</td>
              </tr>
            ))}</tbody>
          </table>
          <div className="row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
            <input name="new" placeholder="Replacement's email (leave empty to just take them off)" style={{ minWidth: 340 }} />
            <button className="btn primary">Change the ticked projects</button>
          </div>
          <p className="small muted">The replacement goes on the same list (To or CC) the person was on. A project&apos;s report list is never left empty.</p>
        </form>
      )}
    </main>
  );
}
