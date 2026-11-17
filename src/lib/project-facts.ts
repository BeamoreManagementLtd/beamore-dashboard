import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";

/**
 * The project information the client sends (Ronan, 17 Nov 2026): the DfE project director and manager, the TA, the
 * principal contractor's project manager, project numbers, CPs, who reports go to. Read from the client's reply, checked
 * by the team, then shared with the job's clerks of works: an email from Ronan's Gmail (sent straight away), the "Your
 * jobs" page on the clerk portal, and a "Project information" Google Doc in the project folder. Nothing financial goes
 * to the clerks: PO numbers, invoicing, fees and rates stay in the office.
 */
export const OFFICE_ONLY = /\bPO\b|purchase order|invoic|fee|rate|cost|payment/i;
export const forClerks = (item: string) => !OFFICE_ONLY.test(item);
const AP = /invoic|payable|purchase\s*ledger|ledger|accounts|finance|credit\s*control/i;
const MODEL = "claude-sonnet-5-5";

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };
const textOf = (pt: Part): string => (pt.mimeType === "text/plain" && pt.body?.data ? Buffer.from(pt.body.data, "base64url").toString("utf8") : (pt.parts ?? []).map(textOf).join("\n"));
// the new part of a reply: up to the quoted earlier email
const ownPart = (t: string) => t.split(/\n(?:On .{5,80} wrote:|-{2,} ?Original Message|From: .+\n(?:Sent|Date): )/i)[0].replace(/\n>.*$/gm, "").trim();

/** Reads the client's recent emails about the job and fills in each checklist item it can. Nothing is saved here. */
export async function readClientInfo(admin: SupabaseClient, projectId: string) {
  const { data: p } = await admin.from("projects").select("name,display_name,diary_aliases,clients(name)").eq("id", projectId).single();
  if (!p) throw new Error("No such project");
  const { data: items } = await admin.from("project_info").select("id,item,value,hint_thread").eq("project_id", projectId).order("created_at");
  if (!items?.length) throw new Error("This project has no checklist yet");
  const g = await driveClient(admin);
  const names = [p.name, ...((p.diary_aliases as string[] | null) ?? [])].filter((n) => n && n.length >= 4).slice(0, 3);
  const found = await g.gmail<{ messages?: { id: string; threadId: string }[] }>("messages", { q: `(${names.map((n) => `"${n}"`).join(" OR ")}) newer_than:9m -from:me`, maxResults: "12" });
  const ids = new Set((found.messages ?? []).map((m) => m.id));
  // threads the dashboard already spotted ("possibly in" hints)
  for (const t of new Set(items.map((i) => i.hint_thread).filter(Boolean) as string[])) {
    const th = await g.gmail<{ messages: { id: string }[] }>(`threads/${t}`, { format: "minimal" }).catch(() => null);
    for (const m of th?.messages ?? []) ids.add(m.id);
  }
  const mails: string[] = [];
  for (const id of [...ids].slice(0, 15)) {
    const m = await g.gmail<{ internalDate: string; payload: Part & { headers: { name: string; value: string }[] } }>(`messages/${id}`, { format: "full" }).catch(() => null);
    if (!m) continue;
    const h = (n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    if (/beamore\.co\.uk/i.test(h("From")) || /automatic reply|out of office|undeliverable/i.test(h("Subject"))) continue;
    const body = ownPart(textOf(m.payload)).slice(0, 5000);
    if (body.length < 20) continue;
    mails.push(`--- Email from ${h("From")}, ${new Date(Number(m.internalDate)).toISOString().slice(0, 10)}, subject "${h("Subject")}"\n${body}`);
  }
  if (!mails.length) return { values: {} as Record<string, string>, emails: 0 };
  const schema = {
    type: "object", additionalProperties: false, required: ["items"],
    properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "value"], properties: {
      id: { type: "string" }, value: { type: ["string", "null"], description: "What the client gave for this item, written out in full: names with their email and phone, numbers, links. null if not in the emails" } } } } },
  };
  const ask = `These are recent emails about the construction project "${p.display_name ?? p.name}" (client ${(p.clients as unknown as { name?: string } | null)?.name ?? "unknown"}). Beamore Management provides the clerk of works and asked the client for the items below. For each item, give exactly what the emails say (names with job title, email address and phone number where given; project numbers; links for drawings or CPs; for a distribution list, every name and email). Leave value null if the emails don't give it. Don't guess.\n\nItems:\n${items.map((i) => `${i.id}: ${i.item}`).join("\n")}\n\n${mails.join("\n\n").slice(0, 60000)}`;
  const res = await new Anthropic().messages.create({
    model: MODEL, max_tokens: 3000,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: ask }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const text = res.content.find((b) => b.type === "text");
  const out = text && text.type === "text" ? (JSON.parse(text.text) as { items: { id: string; value: string | null }[] }).items : [];
  const values: Record<string, string> = {};
  for (const x of out) if (x.value && items.some((i) => i.id === x.id)) values[x.id] = x.value.trim();
  return { values, emails: mails.length };
}

/**
 * The project details from the clerk's most recent report on the job (Ronan, 17 Nov 2026: "get all the information you
 * can from their diaries, the most recent diary, because some people change"). DfE diaries and reports carry the DfE
 * project director and manager, the TA, the principal contractor's project manager and the project numbers in their
 * header. Returns suggested answers by checklist item id, and which report they came from.
 */
export async function readReportInfo(admin: SupabaseClient, projectId: string) {
  const { data: items } = await admin.from("project_info").select("id,item").eq("project_id", projectId).order("created_at");
  if (!items?.length) return { values: {} as Record<string, string>, from: null as string | null };
  const { data: reps } = await admin.from("reports").select("id,file_name,drive_file_id,text_snapshot,uploaded_at,visit_date")
    .eq("project_id", projectId).order("uploaded_at", { ascending: false }).limit(3);
  let text = "", from: string | null = null;
  for (const r of reps ?? []) {
    if (r.text_snapshot) { text = r.text_snapshot.slice(0, 8000); from = r.file_name; break; }
    try {
      const { readReport } = await import("@/lib/reports/docx.mjs");
      const g = await driveClient(admin);
      const rep = await readReport(Buffer.from(await g.download(r.drive_file_id)));
      text = rep.paragraphs.map((x: { text: string }) => x.text).filter((x: string) => x.trim()).join("\n").slice(0, 8000);
      from = r.file_name; break;
    } catch { /* try the one before */ }
  }
  if (!text) return { values: {}, from: null };
  const want = items.filter((i) => forClerks(i.item) && !/distribution|CPs|drawings|programme/i.test(i.item));
  if (!want.length) return { values: {}, from };
  const schema = {
    type: "object", additionalProperties: false, required: ["items"],
    properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "value"], properties: {
      id: { type: "string" }, value: { type: ["string", "null"], description: "Exactly as written in the report: names (with firm, email or phone if given), numbers, address. null if the report doesn't give it or leaves it blank" } } } } },
  };
  const ask = `This is the start of a clerk of works' latest report for a construction project. Fill in each item from it, exactly as written (the header table usually has the DfE project director, DfE project manager, TA / lead consultant, principal contractor and their project manager, project numbers, site address). Leave value null if the report doesn't say or the box is empty. Don't guess.\n\nItems:\n${want.map((i) => `${i.id}: ${i.item}`).join("\n")}\n\nReport (${from}):\n${text}`;
  const res = await new Anthropic().messages.create({
    model: MODEL, max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: ask }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const t = res.content.find((b) => b.type === "text");
  const out = t && t.type === "text" ? (JSON.parse(t.text) as { items: { id: string; value: string | null }[] }).items : [];
  const values: Record<string, string> = {};
  for (const x of out) if (x.value && x.value.trim().length > 1 && want.some((i) => i.id === x.id)) values[x.id] = x.value.trim();
  return { values, from };
}

/** The clerks' copy: what they need on site, never anything financial. */
export async function clerkSheet(admin: SupabaseClient, projectId: string) {
  const { data: p } = await admin.from("projects").select("id,name,display_name,site,report_to,report_cc,drive_folder_id,clerk_id,clerk_me_id,clients(name)").eq("id", projectId).single();
  if (!p) return null;
  const { data: items } = await admin.from("project_info").select("item,value,received_on").eq("project_id", projectId).order("created_at");
  const lines = (items ?? []).filter((i) => forClerks(i.item) && i.value?.trim()).map((i) => ({ label: i.item.replace(/\s*\(.*?\)\s*$/, ""), value: i.value!.trim() }));
  const reports = [p.report_to, p.report_cc].filter(Boolean).join("; ").split(/[;,]\s*/).filter((e) => e.includes("@") && !AP.test(e));
  if (reports.length && !lines.some((l) => /distribution/i.test(l.label))) lines.push({ label: "Reports go to", value: reports.join(", ") });
  // the inspection schedule (Ronan, 17 Nov 2026): planned days per month from the cost schedule, or what's been agreed
  // by phone; days only, never rates or money
  const [{ data: pm }, { data: ag }] = await Promise.all([
    admin.from("project_planned_months").select("month,building,me,building_witness,me_witness").eq("project_id", projectId).order("month"),
    admin.from("workload_agreed").select("kind,days,per,date_from,date_to").eq("project_id", projectId).order("date_from"),
  ]);
  const plan = (pm ?? []).map((r) => ({ month: r.month as string, building: Number(r.building), me: Number(r.me), witness: Number(r.building_witness) + Number(r.me_witness) }))
    .filter((r) => r.building || r.me);
  const agreed = (ag ?? []).map((a) => `${a.kind === "me" ? "M&E" : "Building"}: ${Number(a.days)} day${Number(a.days) === 1 ? "" : "s"} a ${a.per} from ${ukDate(a.date_from)}${a.date_to ? ` to ${ukDate(a.date_to)}` : " until further notice"}`);
  return {
    project: p.display_name ?? p.name, client: (p.clients as unknown as { name?: string } | null)?.name ?? null, site: p.site as string | null,
    folder: p.drive_folder_id ? `https://drive.google.com/drive/folders/${p.drive_folder_id}` : null,
    lines, clerks: [...new Set([p.clerk_id, p.clerk_me_id].filter(Boolean) as string[])], plan, agreed,
  };
}

const ukDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Sends the sheet to the job's clerks (from Ronan's Gmail, straight away) and keeps the Google Doc up to date. Only when
 * something has changed, or to a clerk who hasn't had it yet (a new clerk on the job). Returns what it did.
 */
export async function shareWithClerks(admin: SupabaseClient, projectId: string) {
  const s = await clerkSheet(admin, projectId);
  if (!s || !s.lines.length) return "Nothing to share with the clerk yet";
  const { data: p } = await admin.from("projects").select("info_doc_id,info_shared,drive_folder_id").eq("id", projectId).single();
  const hash = JSON.stringify([s.site, s.lines]);
  const before = (p?.info_shared ?? {}) as { hash?: string; to?: string[] };
  const g = await driveClient(admin);
  const done: string[] = [];

  // the Google Doc in the project folder
  if (p?.drive_folder_id && before.hash !== hash) {
    const html = `<html><body><h1>${esc(s.project)}: project information</h1><p>${esc([s.client, s.site].filter(Boolean).join(" · "))}</p><table border="1" cellpadding="6" style="border-collapse:collapse">${s.lines.map((l) => `<tr><td><b>${esc(l.label)}</b></td><td>${esc(l.value).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table><p style="color:#666">Kept up to date by the Beamore dashboard. Last updated ${new Date().toLocaleDateString("en-GB", { timeZone: "Europe/London" })}.</p></body></html>`;
    try {
      if (p.info_doc_id) await g.replaceContent(p.info_doc_id, Buffer.from(html), "text/html");
      else {
        const b = "beamore_info_doc";
        const body = Buffer.from([`--${b}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify({ name: "Project information", mimeType: "application/vnd.google-apps.document", parents: [p.drive_folder_id] }), `--${b}`, "Content-Type: text/html; charset=UTF-8", "", html, `--${b}--`].join("\r\n"));
        const r = await g.upload(body, `multipart/related; boundary=${b}`) as { id?: string } | undefined;
        if (r?.id) await admin.from("projects").update({ info_doc_id: r.id }).eq("id", projectId);
      }
      done.push("Project information doc updated in the project folder");
    } catch (e) { done.push(`Project information doc not updated: ${e instanceof Error ? e.message.slice(0, 120) : "failed"}`); }
  }

  // the email to each clerk who hasn't had this version
  const { data: clerks } = s.clerks.length ? await admin.from("clerks").select("id,name,email,active").in("id", s.clerks) : { data: [] };
  const sentTo: string[] = [];
  for (const c of clerks ?? []) {
    if (!c.email || !c.active) continue;
    if (before.hash === hash && (before.to ?? []).includes(c.id)) continue;
    const update = !!before.hash && (before.to ?? []).includes(c.id);
    const body = `Hi ${c.name.split(" ")[0]}\n\n${update ? `The project details for ${s.project} have been updated.` : `Here are the project details for ${s.project}.`}\n\n${s.site ? `Site: ${s.site}\n` : ""}${s.lines.map((l) => `${l.label}: ${l.value}`).join("\n")}\n\nThe same details are on the portal (https://portal.beamore.co.uk/portal/jobs) and in the project folder as "Project information"${s.folder ? ` (${s.folder})` : ""}.\n\nRegards\n\nRonan O'Boyle\nBeamore Management Ltd`;
    const subject = `${update ? "Updated project details" : "Project details"}: ${s.project}`;
    await g.sendAutomatic({ to: c.email, subject, body });
    const { queueEmail } = await import("@/lib/outbox");
    await queueEmail(admin, { kind: "clerk-project-info", to: c.email, subject, body, clerkId: c.id, projectId, ref: `${projectId}:${c.id}:${hash.length}`, status: "sent", note: "Sent automatically" }).catch(() => undefined);
    await admin.from("project_events").insert({ project_id: projectId, source: "dashboard", kind: "Email sent", who: "Dashboard", body: `Project details sent to ${c.name} (${c.email})` });
    sentTo.push(c.name);
  }
  await admin.from("projects").update({ info_shared: { hash, at: new Date().toISOString(), to: [...new Set([...(before.hash === hash ? before.to ?? [] : []), ...(clerks ?? []).filter((c) => sentTo.includes(c.name)).map((c) => c.id)])] } }).eq("id", projectId);
  if (sentTo.length) done.push(`Sent to ${sentTo.join(" and ")}`);
  return done.join(". ") || "The clerks already have these details";
}
