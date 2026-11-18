import Link from "next/link";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { OFFICE_ONLY } from "@/lib/reports/clerk-view";
import { AiNote } from "../../feedback";
import { KeepRefreshing } from "./refresh";

export const dynamic = "force-dynamic";

type Part = { label: string; of: number; got: number; note?: string; improve?: string };
type Fixes = { spelling?: { find: string; replace: string }[]; wording?: { find: string; replace: string }[]; score_parts?: Part[]; renamed?: string | null; sideways?: number };
const n1 = (n: number) => (Math.round(n * 10) / 10).toString();

/** The feedback on a draft the clerk checked before uploading it (Ronan, 18 Nov 2026). Their own checks only. */
export default async function PrecheckResult({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requirePortalUser();
  if (!me.clerk) notFound();
  const db = createServiceClient();
  const { data: c } = await db.from("report_prechecks").select("id,clerk_id,file_name,status,error,score,issues,clerk_points,fixes,created_at,projects(name,display_name)").eq("id", id).maybeSingle();
  if (!c || c.clerk_id !== me.clerk.id) notFound();
  const p = c.projects as unknown as { name?: string; display_name?: string } | null;
  const head = (
    <section className="card">
      <p className="small"><Link href="/portal/reports">← Your reports</Link></p>
      <h1 style={{ marginBottom: 2 }}>Check before uploading</h1>
      <p className="muted" style={{ marginTop: 0 }}>{p?.display_name ?? p?.name ?? ""} · {c.file_name}</p>
    </section>
  );
  if (c.status === "uploading" || c.status === "waiting" || c.status === "checking")
    return (
      <>
        {head}
        <section className="card">
          <h2>Checking your report…</h2>
          <p>This usually takes two or three minutes. This page updates by itself; you can also leave it and come back from <Link href="/portal/reports">Your reports</Link>.</p>
          <KeepRefreshing />
        </section>
      </>
    );
  if (c.status === "failed")
    return (
      <>
        {head}
        <section className="card">
          <h2>The check didn&apos;t work this time</h2>
          <p className="neg">{c.error ?? "Something went wrong."}</p>
          <p><Link href="/portal/reports">Try again</Link></p>
        </section>
      </>
    );

  const f = (c.fixes ?? {}) as Fixes;
  const issues = ((c.issues ?? []) as { severity: string; text: string }[]).filter((i) => !OFFICE_ONLY.test(i.text) && !/^(Spelling not changed|Suggested wording changes)/.test(i.text));
  const points = ((c.clerk_points ?? []) as string[]).filter((t) => !OFFICE_ONLY.test(t));
  const parts = (f.score_parts ?? []).filter((x) => x.of > 0);
  return (
    <>
      {head}
      <section className="card">
        <AiNote />
        <p style={{ margin: 0 }}>
          <b>Score as it stands: {c.score !== null && c.score !== undefined ? `${Math.round(Number(c.score))} out of 100` : "not scored"}.</b>{" "}
          <span className="muted">Nothing has been changed in your file and nothing has gone to Google Drive or the office. Make any changes you want in Word, then upload the final report to the job&apos;s Google Drive folder as normal.</span>
        </p>
      </section>

      <section className="card">
        <h2>Suggestions</h2>
        {points.length ? <ul>{points.map((t) => <li key={t}>{t}</li>)}</ul> : <p className="muted">No suggestions: it looks good.</p>}
        {!!issues.length && (
          <details><summary className="small">Everything the check noticed ({issues.length})</summary>
            <ul className="small">{issues.map((i, k) => <li key={k}>{i.text}</li>)}</ul>
          </details>
        )}
      </section>

      <section className="card">
        <h2>Spelling and typing slips</h2>
        {f.spelling?.length ? (
          <>
            <p className="small muted" style={{ marginTop: 0 }}>{f.spelling.length} to correct (the office would otherwise put these right for you):</p>
            <ul className="small">{f.spelling.slice(0, 60).map((s, k) => <li key={k}>&ldquo;{s.find}&rdquo; → &ldquo;{s.replace}&rdquo;</li>)}</ul>
          </>
        ) : <p className="muted">None found.</p>}
        {!!f.wording?.length && (
          <details><summary className="small">Wording you might want to look at ({f.wording.length}): only change these if they&apos;re right</summary>
            <ul className="small">{f.wording.slice(0, 30).map((s, k) => <li key={k}>&ldquo;{s.find}&rdquo; → &ldquo;{s.replace}&rdquo;</li>)}</ul>
          </details>
        )}
      </section>

      {!!parts.length && (
        <section className="card">
          <h2>How each part did</h2>
          <table className="ptable">
            <thead><tr><th>Part</th><th style={{ textAlign: "right" }}>Mark</th><th>What it means</th></tr></thead>
            <tbody>{parts.map((x) => (
              <tr key={x.label}>
                <td>{x.label}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>{n1(x.got)} of {x.of}</td>
                <td className="small">{x.note}{x.improve ? <><br /><span className="muted">{x.improve}</span></> : null}</td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
      <p className="small"><Link href="/portal/reports">Check another report, or this one again after your changes →</Link></p>
    </>
  );
}
