import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A project's email lists (Ronan, 15 Nov 2026): who its reports go to (To / CC) and who its invoices go to (To / CC).
 * Project managers come and go, so anyone on the team can take a name off or add one on the project's page, or swap
 * one person for another across every project at once. The change is saved straight away and marked to be copied into
 * the diary's Projects tab; until it has been, the diary sync leaves that project's lists alone.
 */
export type ListName = "report_to" | "report_cc" | "invoice_to" | "invoice_cc";
export const LIST_LABEL: Record<ListName, string> = { report_to: "Reports to", report_cc: "Reports CC", invoice_to: "Invoices to", invoice_cc: "Invoices CC" };
export type Lists = Record<ListName, string[]>;

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
export const emailsIn = (s: unknown) => [...new Set((String([s ?? ""].flat().join(";")).match(EMAIL) ?? []).map((e) => e.trim()))];
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The four lists for a project (invoice lists: its own contact, else the client's default). */
export async function getLists(db: SupabaseClient, projectId: string) {
  const { data: p } = await db.from("projects").select("id,number,name,client_id,report_to,report_cc,details,clients(name)").eq("id", projectId).single();
  if (!p) throw new Error("No such project");
  const { data: ic } = await db.from("invoice_contacts").select("id,project_id,client_id,label,to_emails,cc_emails,notes")
    .or(`project_id.eq.${projectId}${p.client_id ? `,client_id.eq.${p.client_id}` : ""}`);
  const own = (ic ?? []).find((c) => c.project_id === projectId);
  const inv = own ?? (ic ?? []).find((c) => !c.project_id);
  const lists: Lists = { report_to: emailsIn(p.report_to), report_cc: emailsIn(p.report_cc), invoice_to: emailsIn(inv?.to_emails), invoice_cc: emailsIn(inv?.cc_emails) };
  const pending = !!(p.details as Record<string, unknown> | null)?._lists_pending;
  return { project: p, lists, invoiceFromClient: !own && !!inv, invoiceLabel: own?.label ?? inv?.label ?? null, invoiceNotes: own?.notes ?? inv?.notes ?? null, pending };
}

/** Saves new lists for a project, logs what changed, and marks them to be copied into the diary. */
export async function saveLists(admin: SupabaseClient, projectId: string, next: Lists, who: string, why?: string) {
  const cur = await getLists(admin, projectId);
  const p = cur.project;
  const changes: string[] = [];
  for (const k of Object.keys(LIST_LABEL) as ListName[]) {
    const gone = cur.lists[k].filter((e) => !next[k].some((n) => same(n, e))), added = next[k].filter((e) => !cur.lists[k].some((c) => same(c, e)));
    if (gone.length) changes.push(`${LIST_LABEL[k]}: removed ${gone.join(", ")}`);
    if (added.length) changes.push(`${LIST_LABEL[k]}: added ${added.join(", ")}`);
  }
  if (!changes.length) return [];
  if (next.report_to.length + next.report_cc.length === 0 && cur.lists.report_to.length) throw new Error("That would leave nobody getting the reports");

  const invChanged = changes.some((c) => c.startsWith("Invoices"));
  const was = ((p.details ?? {}) as Record<string, unknown>)._lists_pending as { invoice?: boolean } | undefined;
  const details = { ...((p.details ?? {}) as Record<string, unknown>), _lists_pending: { at: new Date().toISOString(), report: true, invoice: invChanged || !!was?.invoice } };
  await admin.from("projects").update({ report_to: next.report_to.join("; ") || null, report_cc: next.report_cc.join("; ") || null, details, updated_at: new Date().toISOString() }).eq("id", projectId);
  if (invChanged) {
    // the project gets its own invoice contact (a client's default stays as it is for its other projects)
    const client = (p.clients as unknown as { name?: string } | null)?.name ?? "";
    await admin.from("invoice_contacts").delete().eq("project_id", projectId);
    if (next.invoice_to.length) await admin.from("invoice_contacts").insert({ project_id: projectId, client_id: null, label: cur.invoiceFromClient || !cur.invoiceLabel ? `${client} - ${p.name}` : cur.invoiceLabel, to_emails: next.invoice_to, cc_emails: next.invoice_cc, notes: cur.invoiceNotes });
  }
  await admin.from("project_events").insert({ project_id: projectId, source: "team", kind: "Email lists", who, body: `${changes.join("; ")}${why ? ` (${why})` : ""}` });
  return changes;
}

/** Every project a person is on, and which of its lists. */
export async function findPerson(db: SupabaseClient, email: string) {
  const e = email.trim().toLowerCase();
  if (!e) return [];
  const like = `%${e.replace(/[%_]/g, "")}%`;
  const [{ data: byReport }, { data: ics }] = await Promise.all([
    db.from("projects").select("id").or(`report_to.ilike.${like},report_cc.ilike.${like}`),
    db.from("invoice_contacts").select("project_id,client_id,to_emails,cc_emails"),
  ]);
  const ids = new Set((byReport ?? []).map((x) => x.id as string));
  // invoice lists are arrays: check them here (a client's default counts for each of its projects that uses it)
  const hits = (ics ?? []).filter((c) => [...(c.to_emails ?? []), ...(c.cc_emails ?? [])].some((x: string) => x.toLowerCase().includes(e)));
  for (const c of hits) if (c.project_id) ids.add(c.project_id);
  const clientHits = hits.filter((c) => !c.project_id && c.client_id).map((c) => c.client_id as string);
  if (clientHits.length) {
    const own = new Set((ics ?? []).filter((c) => c.project_id).map((c) => c.project_id as string));
    const { data: ps } = await db.from("projects").select("id").in("client_id", clientHits).in("stage", ["live", "won_arranging", "won_preparing", "on_hold"]);
    for (const x of ps ?? []) if (!own.has(x.id)) ids.add(x.id);
  }
  const out: { id: string; number: number; name: string; stage: string; on: ListName[]; lists: Lists }[] = [];
  for (const id of ids) {
    const l = await getLists(db, id);
    const on = (Object.keys(LIST_LABEL) as ListName[]).filter((k) => l.lists[k].some((x) => x.toLowerCase().includes(e)));
    if (on.length) out.push({ id, number: l.project.number, name: l.project.name, stage: "", on, lists: l.lists });
  }
  const { data: st } = await db.from("projects").select("id,stage").in("id", out.map((o) => o.id));
  for (const o of out) o.stage = st?.find((s) => s.id === o.id)?.stage ?? "";
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
