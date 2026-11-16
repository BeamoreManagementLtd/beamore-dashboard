import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Profile } from "@/lib/auth";
import { buildDueList } from "@/lib/due";
import { driveClient } from "@/lib/google";
import { createServiceClient } from "@/lib/supabase/server";
import { AI_MODEL } from "@/lib/portal/read-document";
import { staffPeople } from "@/lib/staff";

/**
 * "Ask the dashboard" (Ronan, 15 Nov 2026): staff ask questions and get work done in plain English.
 *  - Lookups and actions go through the signed-in person's own database client, so row-level security applies
 *    (admins can't reach director-only finance). Every action is logged in ai_log with who asked.
 *  - Beamore work only. Anything else, staff's bigger actions (won/lost, email drafts from Ronan's account), and going
 *    over the daily limit become an approval request: Ronan sees a pop-up on the dashboard and approves or denies.
 *  - Ronan isn't limited.
 */
export type Turn = { role: "user" | "assistant"; text: string };

const S = (description: string) => ({ type: "string", description }) as const;
const TOOLS: Anthropic.Tool[] = [
  { name: "find_projects", description: "List projects matching a name/number/client and/or a stage. Use this first to find a project's number.",
    input_schema: { type: "object", properties: { text: S("part of the project name, number or client"), stage: S("enquiry, pricing, sent, won_arranging, won_preparing, live, on_hold, lost or complete") } } },
  { name: "project", description: "Everything about one project: client, stage, clerks, start date, PO, DfE details, information received/outstanding, recent activity, invoices and diary days by month.",
    input_schema: { type: "object", properties: { number: { type: "integer", description: "the project number, e.g. 1104" } }, required: ["number"] } },
  { name: "clerks", description: "Clerks of works: contact details, insurance/CSCS/membership expiries, and where they've worked in the last 60 days. Leave text empty for everyone.",
    input_schema: { type: "object", properties: { text: S("part of a clerk's name") } } },
  { name: "overdue_invoices", description: "Unpaid client invoices past their due date, with chase status. Optionally for one client.",
    input_schema: { type: "object", properties: { client: S("part of the client name") } } },
  { name: "due_list", description: "The dashboard's to-do / due list (chases, set-ups, clerks to find, renewals, tasks).",
    input_schema: { type: "object", properties: { who: S("a first name (e.g. Judy) to show only theirs, or empty for everyone") } } },
  { name: "diary", description: "Days in the diary (charged = salmon side, planned = grey side) for a clerk and/or project between two dates.",
    input_schema: { type: "object", properties: { clerk: S("part of the clerk's name"), project_number: { type: "integer" }, from: S("YYYY-MM-DD"), to: S("YYYY-MM-DD") }, required: ["from", "to"] } },
  { name: "portal_uploads", description: "What clerks have uploaded on the clerk portal (insurance, certificates, invoices) and any problems.",
    input_schema: { type: "object", properties: { clerk: S("part of the clerk's name"), problems_only: { type: "boolean" } } } },
  { name: "reports", description: "Clerk of works reports the dashboard has checked: project, clerk, report number, visit date, status (new, checking, ready = checked and waiting to be sent, approved, sent, done), score out of 100 with how it was worked out, the issues found, spelling fixed, who checks it, when sent. Sort by score to find the best or worst.",
    input_schema: { type: "object", properties: { clerk: S("part of the clerk's name"), project: S("part of the project name, or its number"), status: S("one status, or empty for all"), from: S("visit date from, YYYY-MM-DD"), to: S("visit date to, YYYY-MM-DD"), sort: { type: "string", enum: ["score_high", "score_low", "newest"] }, limit: { type: "integer", description: "default 20, up to 100" }, detail: { type: "boolean", description: "include the score breakdown and all issues (use for one or a few reports)" } } } },
  { name: "report_scores", description: "Report scores by clerk: average and latest score out of 100, how many reports, best and worst, and whether they're improving. Scores are for the office only; never pass them on to clerks.",
    input_schema: { type: "object", properties: { clerk: S("part of a clerk's name, or empty for everyone"), days: { type: "integer", description: "how far back, default 90" } } } },
  { name: "lookup", description: `Read any business table directly when the other tools don't cover it. Tables: ${"{TABLES}"}. Filters are exact (eq), contains (ilike, case-insensitive), on/after (gte), on/before (lte), empty (is_null) or filled (not_null). Use columns "*" first if unsure of the column names.`,
    input_schema: { type: "object", properties: {
      table: S("one of the tables listed"), columns: S("comma-separated column names, or * (default)"),
      filters: { type: "array", items: { type: "object", properties: { column: S("column"), op: { type: "string", enum: ["eq", "ilike", "gte", "lte", "is_null", "not_null"] }, value: S("value (not needed for is_null/not_null)") }, required: ["column", "op"] } },
      order: S("column to sort by; add ' desc' for newest/highest first"), limit: { type: "integer", description: "default 30, up to 100" },
    }, required: ["table"] } },
  // ---- actions (they change things; everything is logged)
  { name: "add_task", description: "Add a to-do on the dashboard (it also appears in Todoist for Ronan, Judy and Anel).",
    input_schema: { type: "object", properties: { title: S("what needs doing"), for_person: S("first name of who it's for (Ronan, Judy, Anel, Andy); empty = the person asking"), due: S("YYYY-MM-DD, optional") }, required: ["title"] } },
  { name: "complete_task", description: "Tick off an open to-do, found by part of its wording.",
    input_schema: { type: "object", properties: { text: S("part of the task's wording") }, required: ["text"] } },
  { name: "add_note", description: "Add a note to a project's activity log (e.g. a phone call, a decision, an update).",
    input_schema: { type: "object", properties: { number: { type: "integer" }, note: S("the note") }, required: ["number", "note"] } },
  { name: "set_clerk", description: "Set a project's building or M&E clerk, or mark that we need to find one.",
    input_schema: { type: "object", properties: { number: { type: "integer" }, role: { type: "string", enum: ["building", "me"] }, clerk: S("the clerk's name, or 'finding'") }, required: ["number", "role", "clerk"] } },
  { name: "info_received", description: "Mark an item of project information as received (e.g. CPs, programme, PO, distribution list).",
    input_schema: { type: "object", properties: { number: { type: "integer" }, item: S("part of the item's name"), date: S("YYYY-MM-DD, default today") }, required: ["number", "item"] } },
  { name: "mark_won_or_lost", description: "Mark a priced project as won (starts its set-up: checklist, folder, Xero) or lost.",
    input_schema: { type: "object", properties: { number: { type: "integer" }, outcome: { type: "string", enum: ["won", "lost"] }, reason: S("if lost, why") }, required: ["number", "outcome"] } },
  { name: "draft_email", description: "Save an email as a DRAFT in Ronan's Gmail (never sent; Ronan sends it). For work emails to clients, clerks or contractors.",
    input_schema: { type: "object", properties: { to: S("email address(es), comma separated"), subject: S("subject"), body: S("plain text body, signed off as Ronan") }, required: ["to", "subject", "body"] } },
  { name: "request_permission", description: "Use this INSTEAD of answering when the request isn't Beamore work (or you're unsure): it asks Ronan to allow it.",
    input_schema: { type: "object", properties: { summary: S("what they want, in a few plain words") }, required: ["summary"] } },
  { name: "search_email", description: "Search Ronan's Gmail (director only). Gmail search syntax works, e.g. 'from:gleeds Beaumont newer_than:60d'.",
    input_schema: { type: "object", properties: { query: S("Gmail search") }, required: ["query"] } },
];

const first = (me: Profile) => (me.full_name ?? me.email).split(" ")[0];

/**
 * What "lookup" can read (Ronan, 16 Nov 2026: anything about the business except private financials). Staff get the
 * business tables; the director also gets the finance ones. Logins, tokens and the AI's own logs are never readable.
 */
const BUSINESS_TABLES = ["projects", "clients", "clerks", "clerk_compliance", "clerk_companies", "clerk_evidence", "clerk_candidates", "job_applications",
  "onboarding_items", "insurance_policies", "reports", "report_queue", "report_settings", "diary_visits", "absences", "holiday_requests", "site_aliases",
  "project_info", "project_events", "project_steps", "project_contacts", "project_planned_months", "price_requests", "proposal_revisions",
  "portal_uploads", "portal_expectations", "tasks", "invoices", "chase_state", "chase_events", "invoice_contacts"];
const FINANCE_TABLES = ["rates", "clerk_costs", "project_finance", "finance_snapshots", "proposal_revision_fees", "month_signoffs", "invoice_drafts", "xero_draft_invoices", "portal_invoice_checks"];
TOOLS.find((x) => x.name === "lookup")!.description = TOOLS.find((x) => x.name === "lookup")!.description!.replace("{TABLES}", `${BUSINESS_TABLES.join(", ")} (and for Ronan only: ${FINANCE_TABLES.join(", ")})`);

// scores are given out of 100 only (Ronan, 16 Nov 2026)
const out10 = (n: number | null | undefined) => (typeof n === "number" ? { out_of_100: Math.round(n) } : null);
// The clerk a report belongs to (Ronan, 16 Nov 2026: one line per clerk when ranking). The name written on the report
// wins (whoever covered the visit wrote it), matched to the clerks list by surname and first initial, so "Andy
// Collier", "A Collier" and "Andrew Collier" are one person; the linked clerk only when the report names nobody.
async function clerkNamer(db: SupabaseClient) {
  const clerks = ((await db.from("clerks").select("id,name")).data ?? []) as { id: string; name: string }[];
  const parts = (n: string) => n.toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter(Boolean);
  const byId = new Map(clerks.map((c) => [c.id, c.name]));
  return (written: string | null, clerkId: string | null) => {
    const w = parts(written ?? "");
    if (w.length >= 2) {
      const sur = w.at(-1)!, init = w[0][0];
      const hits = clerks.filter((c) => { const p = parts(c.name); return p.at(-1) === sur && p[0]?.[0] === init; });
      if (hits.length === 1) return hits[0].name;
      const linked = clerkId ? byId.get(clerkId) : null;
      if (linked && parts(linked).at(-1) === sur) return linked;
      const same = clerks.filter((c) => parts(c.name).at(-1) === sur); // "Antony" / "Tony" Larkins: the only Larkins
      if (same.length === 1) return same[0].name;
    }
    return written?.trim() || (clerkId && byId.get(clerkId)) || "Unknown";
  };
}
const isNew = (r: { fixes?: unknown }) => (r.fixes as { score_by?: string } | null)?.score_by === "parts";

export async function run(db: SupabaseClient, me: Profile, name: string, a: Record<string, unknown>): Promise<unknown> {
  const t = new Date().toISOString().slice(0, 10);
  const like = (v: unknown) => `%${String(v ?? "").trim()}%`;
  const clerkNames = async () => new Map(((await db.from("clerks").select("id,name")).data ?? []).map((c) => [c.id as string, c.name as string]));

  switch (name) {
    case "find_projects": {
      let q = db.from("projects").select("number,display_name,stage,start_date,is_dfe,clerk_id,clerk_status,clerk_me_id,clerk_me_status,clients(name)").order("number", { ascending: false }).limit(40);
      if (a.text) {
        const n = Number(a.text);
        q = Number.isInteger(n) && n > 999 ? q.eq("number", n) : q.or(`display_name.ilike.${like(a.text)},name.ilike.${like(a.text)}`);
      }
      if (a.stage) q = q.eq("stage", String(a.stage));
      const { data } = await q;
      let rows = data ?? [];
      if (a.text && !rows.length) { // try the client name
        const { data: cl } = await db.from("clients").select("id").or(`name.ilike.${like(a.text)}`);
        if (cl?.length) rows = (await db.from("projects").select("number,display_name,stage,start_date,is_dfe,clerk_id,clerk_status,clerk_me_id,clerk_me_status,clients(name)").in("client_id", cl.map((c) => c.id)).order("number", { ascending: false }).limit(40)).data ?? [];
      }
      const names = await clerkNames();
      return rows.map((p) => ({ number: p.number, name: p.display_name, client: (p.clients as unknown as { name: string } | null)?.name, stage: p.stage, start: p.start_date, dfe: p.is_dfe,
        clerk: p.clerk_id ? names.get(p.clerk_id) : p.clerk_status, me_clerk: p.clerk_me_id ? names.get(p.clerk_me_id) : p.clerk_me_status }));
    }
    case "project": {
      const { data: p } = await db.from("projects").select("*,clients(name)").eq("number", Number(a.number)).maybeSingle();
      if (!p) return { error: "No project with that number" };
      const names = await clerkNames();
      const [{ data: info }, { data: ev }, { data: inv }, { data: vis }] = await Promise.all([
        db.from("project_info").select("item,requested_on,received_on,note").eq("project_id", p.id),
        db.from("project_events").select("happened_at,kind,who,body").eq("project_id", p.id).order("happened_at", { ascending: false }).limit(20),
        db.from("invoices").select("number,issued,due,total,amount_due,status").eq("project_id", p.id).order("issued", { ascending: false }).limit(24),
        db.from("diary_visits").select("visit_date,kind,side,days").eq("project_id", p.id).gte("visit_date", new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)),
      ]);
      const months: Record<string, Record<string, number>> = {};
      for (const v of vis ?? []) { const m = v.visit_date.slice(0, 7); months[m] ??= {}; const k = `${v.side} ${v.kind}`; months[m][k] = (months[m][k] ?? 0) + Number(v.days); }
      const { id: _id, client_id: _c, ...rest } = p as Record<string, unknown>;
      void _id; void _c;
      return {
        ...rest, client: (p.clients as unknown as { name: string } | null)?.name, clients: undefined,
        building_clerk: p.clerk_id ? names.get(p.clerk_id) : p.clerk_status, me_clerk: p.clerk_me_id ? names.get(p.clerk_me_id) : p.clerk_me_status,
        link: `/projects/${p.id}`, information: info, recent_activity: ev, invoices: inv, diary_days_by_month: months,
      };
    }
    case "clerks": {
      let q = db.from("clerks").select("id,name,email,phone,active,clerk_compliance(pi_insurance_expiry,pl_insurance_expiry,cscs_expiry,chartership_body,chartership_number,chartership_renewal,dbs_recheck,company_name)").eq("active", true).order("name");
      if (a.text) q = q.ilike("name", like(a.text));
      const { data } = await q.limit(60);
      const since = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
      const ids = (data ?? []).map((c) => c.id);
      const { data: vis } = ids.length <= 10 ? await db.from("diary_visits").select("clerk_id,site_as_typed,visit_date,side").in("clerk_id", ids).gte("visit_date", since) : { data: [] };
      return (data ?? []).map((c) => ({
        name: c.name, email: c.email, phone: c.phone, ...(Array.isArray(c.clerk_compliance) ? c.clerk_compliance[0] : c.clerk_compliance),
        recent_sites: [...new Set((vis ?? []).filter((v) => v.clerk_id === c.id).map((v) => v.site_as_typed))],
        link: `/personnel/${c.id}`,
      }));
    }
    case "overdue_invoices": {
      const { data } = await db.from("invoices").select("number,issued,due,amount_due,reference,clients(name),chase_state(status,next_action,next_action_due,promised_date)").gt("amount_due", 0).lt("due", t).order("due");
      return (data ?? []).filter((i) => !a.client || ((i.clients as unknown as { name: string } | null)?.name ?? "").toLowerCase().includes(String(a.client).toLowerCase()))
        .map((i) => ({ number: i.number, client: (i.clients as unknown as { name: string } | null)?.name, reference: i.reference, issued: i.issued, due: i.due, amount_due: i.amount_due, chase: i.chase_state }));
    }
    case "due_list": {
      const items = await buildDueList(db, me);
      return items.filter((i) => !a.who || (i.owner ?? "").toLowerCase().startsWith(String(a.who).toLowerCase()))
        .slice(0, 80).map((i) => ({ title: i.title, detail: i.detail, due: i.due, owner: i.owner, kind: i.kind, link: i.link }));
    }
    case "diary": {
      let q = db.from("diary_visits").select("visit_date,site_as_typed,kind,side,days,clerks(name),projects(number,display_name)").gte("visit_date", String(a.from)).lte("visit_date", String(a.to)).order("visit_date").limit(600);
      if (a.project_number) { const { data: p } = await db.from("projects").select("id").eq("number", Number(a.project_number)).maybeSingle(); if (p) q = q.eq("project_id", p.id); }
      if (a.clerk) { const { data: c } = await db.from("clerks").select("id").ilike("name", like(a.clerk)); q = q.in("clerk_id", (c ?? []).map((x) => x.id)); }
      const { data } = await q;
      const totals: Record<string, number> = {};
      for (const v of data ?? []) { const k = `${(v.clerks as unknown as { name: string } | null)?.name} · ${(v.projects as unknown as { display_name: string } | null)?.display_name ?? v.site_as_typed} · ${v.side} ${v.kind}`; totals[k] = (totals[k] ?? 0) + Number(v.days); }
      return { totals_in_days: totals, visits: (data ?? []).slice(0, 150).map((v) => [v.visit_date, (v.clerks as unknown as { name: string } | null)?.name, v.site_as_typed, v.side, v.days]) };
    }
    case "portal_uploads": {
      let q = db.from("portal_uploads").select("kind,doc_type,file_name,received_at,status,issues,clerks(name)").neq("status", "deleted").order("received_at", { ascending: false }).limit(80);
      if (a.problems_only) q = q.in("status", ["needs_correction", "needs_beamore"]);
      const { data } = await q;
      return (data ?? []).filter((u) => !a.clerk || ((u.clerks as unknown as { name: string } | null)?.name ?? "").toLowerCase().includes(String(a.clerk).toLowerCase()))
        .map((u) => ({ clerk: (u.clerks as unknown as { name: string } | null)?.name, kind: u.kind, type: u.doc_type, file: u.file_name, received: u.received_at.slice(0, 10), status: u.status, issues: u.issues }));
    }
    case "add_task": {
      const staff = await staffPeople(createServiceClient());
      const who = String(a.for_person ?? "").trim().toLowerCase();
      const p = who ? staff.find((x) => x.first.toLowerCase() === who) : staff.find((x) => x.email === me.email);
      if (who && !p) return { error: `No one called ${a.for_person} on the dashboard` };
      const { error } = await db.from("tasks").insert({ title: String(a.title).slice(0, 300), due: a.due || null, owner_id: p?.profileId ?? null, owner_name: p?.profileId ? null : p?.first ?? null, kind: `Added by ${first(me)} (Ask)` });
      return error ? { error: error.message } : { done: `Added to ${p?.first ?? "the"} list` };
    }
    case "complete_task": {
      const { data } = await db.from("tasks").select("id,title").is("done_at", null).ilike("title", like(a.text)).limit(5);
      if (!data?.length) return { error: "No open task with that wording" };
      if (data.length > 1) return { error: "More than one task matches; which one?", matches: data.map((x) => x.title) };
      await db.from("tasks").update({ done_at: new Date().toISOString(), ai_note: `Ticked off via Ask by ${first(me)}` }).eq("id", data[0].id);
      return { done: `Ticked off: ${data[0].title}` };
    }
    case "add_note": {
      const { data: p } = await db.from("projects").select("id,display_name").eq("number", Number(a.number)).maybeSingle();
      if (!p) return { error: "No project with that number" };
      const { error } = await db.from("project_events").insert({ project_id: p.id, source: "team", kind: "Note", who: first(me), body: String(a.note).slice(0, 2000), created_by: me.id });
      return error ? { error: error.message } : { done: `Note added to ${p.display_name}` };
    }
    case "set_clerk": {
      const { data: p } = await db.from("projects").select("id,display_name").eq("number", Number(a.number)).maybeSingle();
      if (!p) return { error: "No project with that number" };
      const isMe = a.role === "me";
      const f = isMe ? { id: "clerk_me_id", status: "clerk_me_status", source: "clerk_me_source" } : { id: "clerk_id", status: "clerk_status", source: "clerk_source" };
      if (String(a.clerk).toLowerCase() === "finding") {
        await db.from("projects").update({ [f.id]: null, [f.status]: "finding", [f.source]: "manual" }).eq("id", p.id);
        return { done: `${p.display_name}: now finding ${isMe ? "an M&E" : "a building"} clerk` };
      }
      const { data: c } = await db.from("clerks").select("id,name").ilike("name", like(a.clerk)).eq("active", true);
      if (c?.length !== 1) return { error: c?.length ? "More than one clerk matches" : "No clerk with that name", matches: c?.map((x) => x.name) };
      await db.from("projects").update({ [f.id]: c[0].id, [f.status]: "have", [f.source]: "manual" }).eq("id", p.id);
      await db.from("project_events").insert({ project_id: p.id, source: "team", kind: isMe ? "M&E clerk of works" : "Clerk of works", who: first(me), body: `${isMe ? "M&E clerk" : "Clerk"}: ${c[0].name} (via Ask)`, created_by: me.id });
      return { done: `${p.display_name}: ${isMe ? "M&E" : "building"} clerk is ${c[0].name}` };
    }
    case "info_received": {
      const { data: p } = await db.from("projects").select("id,display_name").eq("number", Number(a.number)).maybeSingle();
      if (!p) return { error: "No project with that number" };
      const { data: items } = await db.from("project_info").select("id,item").eq("project_id", p.id).is("received_on", null).ilike("item", like(a.item));
      if (items?.length !== 1) return { error: items?.length ? "More than one item matches" : "No outstanding item with that name", matches: items?.map((x) => x.item) };
      await db.from("project_info").update({ received_on: a.date || t, note: `Marked received via Ask by ${first(me)}` }).eq("id", items[0].id);
      return { done: `${p.display_name}: ${items[0].item} received` };
    }
    case "mark_won_or_lost": {
      const { data: p } = await db.from("projects").select("id,display_name").eq("number", Number(a.number)).maybeSingle();
      if (!p) return { error: "No project with that number" };
      if (a.outcome === "won") {
        await db.from("projects").update({ stage: "won_arranging", stage_changed_at: new Date().toISOString() }).eq("id", p.id);
        const { onWon } = await import("@/lib/project-setup");
        await onWon(createServiceClient(), p.id).catch(() => undefined);
      } else await db.from("projects").update({ stage: "lost", lost_reason: a.reason ? String(a.reason) : null }).eq("id", p.id);
      await db.from("project_events").insert({ project_id: p.id, source: "team", kind: a.outcome === "won" ? "Won" : "Lost", who: first(me), body: `Marked ${a.outcome} via Ask${a.reason ? `: ${a.reason}` : ""}`, created_by: me.id });
      return { done: `${p.display_name} marked ${a.outcome}` };
    }
    case "draft_email": {
      const CRLF = String.fromCharCode(13, 10);
      const raw = [`To: ${a.to}`, `Subject: ${a.subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8"].join(CRLF) + CRLF + CRLF + String(a.body).split(/\r?\n/).join(CRLF);
      const g = await driveClient(createServiceClient());
      await g.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw: Buffer.from(raw).toString("base64url") } });
      return { done: "Saved in Ronan's Gmail Drafts (not sent)" };
    }
    case "reports": {
      let q = db.from("reports").select("id,file_name,status,score,visit_date,report_number,clerk_name,clerk_id,kind,uploaded_at,checked_at,sent_at,spelling_fixed,issues,fixes,error,folder_name,project_folder_name,checker_id,projects(number,display_name)");
      if (a.status) q = q.eq("status", String(a.status));
      if (a.from) q = q.gte("visit_date", String(a.from));
      if (a.to) q = q.lte("visit_date", String(a.to));
      if (a.clerk) q = q.ilike("clerk_name", like(a.clerk));
      if (a.project) {
        const n = Number(a.project);
        const { data: ps } = Number.isInteger(n) && n > 0 ? await db.from("projects").select("id").eq("number", n) : await db.from("projects").select("id").ilike("display_name", like(a.project));
        q = q.in("project_id", (ps ?? []).map((p) => p.id));
      }
      const sort = String(a.sort ?? "newest");
      q = sort === "newest" ? q.order("uploaded_at", { ascending: false }) : q.not("score", "is", null).order("score", { ascending: sort === "score_low" });
      const { data, error } = await q.limit(Math.min(100, Number(a.limit) || 20));
      if (error) return { error: error.message };
      const rows = data ?? [];
      const staff = new Map(((await db.from("profiles").select("id,full_name")).data ?? []).map((x) => [x.id as string, x.full_name as string]));
      const who = await clerkNamer(db);
      return rows.map((r) => {
        const fx = (r.fixes ?? {}) as { score_parts?: { label: string; got: number; of: number; note?: string; improve?: string }[]; spelling?: unknown[] };
        const issues = (r.issues ?? []) as { severity: string; text: string }[];
        const p = r.projects as unknown as { number?: number; display_name?: string } | null;
        return {
          project: p ? `${p.display_name} ${p.number}` : r.project_folder_name, clerk: who(r.clerk_name, r.clerk_id), report: r.report_number, visit_date: r.visit_date, file: r.file_name, kind: r.kind === "me" ? "M&E" : "building",
          status: r.status, score: out10(r.score), score_method: r.score == null ? null : isNew(r) ? "current (7 parts)" : "old scoring", checked: r.checked_at?.slice(0, 10) ?? null, sent: r.sent_at?.slice(0, 10) ?? null,
          checker: r.checker_id ? staff.get(r.checker_id) ?? null : null, spelling_fixed: r.spelling_fixed, problem: r.error,
          ...(a.detail ? { score_breakdown: fx.score_parts ?? null, issues } : { main_issues: issues.filter((i) => i.severity !== "low").slice(0, 3).map((i) => i.text.slice(0, 160)) }),
          link: `/reports/${r.id}`,
        };
      });
    }
    case "report_scores": {
      const since = new Date(Date.now() - (Number(a.days) || 90) * 864e5).toISOString().slice(0, 10);
      const { data } = await db.from("reports").select("clerk_name,clerk_id,score,visit_date,uploaded_at,fixes,projects(display_name,number)").not("score", "is", null).gte("uploaded_at", since).order("uploaded_at").limit(1000);
      const who = await clerkNamer(db);
      const by = new Map<string, { score: number; at: string; project: string }[]>();
      for (const r of (data ?? []).filter(isNew)) {
        const p = r.projects as unknown as { display_name?: string; number?: number } | null;
        const k = who(r.clerk_name, r.clerk_id);
        if (a.clerk && !k.toLowerCase().includes(String(a.clerk).toLowerCase()) && !(r.clerk_name ?? "").toLowerCase().includes(String(a.clerk).toLowerCase())) continue;
        by.set(k, [...(by.get(k) ?? []), { score: Number(r.score), at: String(r.visit_date ?? r.uploaded_at).slice(0, 10), project: p ? `${p.display_name} ${p.number}` : "" }]);
      }
      return [...by].map(([clerk, l]) => {
        const avg = l.reduce((s, x) => s + x.score, 0) / l.length;
        const half = Math.floor(l.length / 2);
        const early = half ? l.slice(0, half).reduce((s, x) => s + x.score, 0) / half : null, late = half ? l.slice(half).reduce((s, x) => s + x.score, 0) / (l.length - half) : null;
        const best = l.reduce((m, x) => (x.score > m.score ? x : m)), worst = l.reduce((m, x) => (x.score < m.score ? x : m));
        return { clerk, reports: l.length, average: out10(avg), latest: { ...out10(l.at(-1)!.score), on: l.at(-1)!.at, project: l.at(-1)!.project }, best: { ...out10(best.score), project: best.project }, worst: { ...out10(worst.score), project: worst.project },
          trend: early == null || late == null ? "too few reports" : late - early >= 3 ? "improving" : early - late >= 3 ? "getting worse" : "steady" };
      }).sort((x, y) => (y.average?.out_of_100 ?? 0) - (x.average?.out_of_100 ?? 0));
    }
    case "lookup": {
      const table = String(a.table ?? "");
      const allowed = me.role === "director" ? [...BUSINESS_TABLES, ...FINANCE_TABLES] : BUSINESS_TABLES;
      if (!allowed.includes(table)) return { error: FINANCE_TABLES.includes(table) ? "That's private financial information (Ronan only)." : `Not a table I can read. Tables: ${allowed.join(", ")}` };
      const ident = /^[a-z_][a-z0-9_]*$/;
      const cols = String(a.columns ?? "*").split(",").map((c) => c.trim()).filter(Boolean);
      if (!cols.every((c) => c === "*" || ident.test(c))) return { error: "Column names are letters and underscores only" };
      let q = db.from(table).select(cols.join(","));
      for (const f of (Array.isArray(a.filters) ? a.filters : []) as { column: string; op: string; value?: string }[]) {
        if (!ident.test(f.column ?? "")) return { error: `Bad column ${f.column}` };
        const v = String(f.value ?? "");
        if (f.op === "eq") q = q.eq(f.column, v);
        else if (f.op === "ilike") q = q.ilike(f.column, like(v));
        else if (f.op === "gte") q = q.gte(f.column, v);
        else if (f.op === "lte") q = q.lte(f.column, v);
        else if (f.op === "is_null") q = q.is(f.column, null);
        else if (f.op === "not_null") q = q.not(f.column, "is", null);
      }
      if (a.order) {
        const [col, dir] = String(a.order).trim().split(/\s+/);
        if (ident.test(col)) q = q.order(col, { ascending: dir?.toLowerCase() !== "desc", nullsFirst: false });
      }
      const { data, error } = await q.limit(Math.min(100, Number(a.limit) || 30));
      if (error) return { error: error.message };
      // big text columns cut down so the answer fits
      return (data ?? []).map((row) => Object.fromEntries(Object.entries(row as unknown as Record<string, unknown>).filter(([k]) => !/token|secret|password|hash/i.test(k)).map(([k, v]) => [k, typeof v === "string" && v.length > 600 ? `${v.slice(0, 600)}…` : v])));
    }
    case "search_email": {
      if (me.role !== "director") return { error: "Only Ronan can search his email." };
      const g = await driveClient(createServiceClient());
      const r = await g.gmail<{ threads?: { id: string; snippet?: string }[] }>("threads", { q: String(a.query), maxResults: "12" });
      const out = [];
      for (const th of r.threads ?? []) {
        const full = await g.gmail<{ messages: { snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }[] }>(`threads/${th.id}`, { format: "metadata", metadataHeaders: ["From", "To", "Subject"] });
        out.push(full.messages.slice(-4).map((m) => {
          const h = (n: string) => m.payload?.headers?.find((x) => x.name === n)?.value ?? "";
          return { date: m.internalDate ? new Date(Number(m.internalDate)).toISOString().slice(0, 10) : "", from: h("From"), to: h("To"), subject: h("Subject"), text: (m.snippet ?? "").slice(0, 300) };
        }));
      }
      return out;
    }
  }
  return { error: "Unknown lookup" };
}

const ACTIONS = new Set(["add_task", "complete_task", "add_note", "set_clerk", "info_received", "mark_won_or_lost", "draft_email"]);
const NEEDS_RONAN = new Set(["mark_won_or_lost", "draft_email"]); // when staff ask for these, Ronan approves first
export const DAILY_LIMIT = 40; // questions a day per staff member before Ronan's OK is needed

type Opts = { approvedOffTopic?: boolean; noLimit?: boolean };

/** Puts a request in front of Ronan (the pop-up on his dashboard). */
async function requestApproval(db: SupabaseClient, me: Profile, kind: "off_topic" | "action" | "over_limit", summary: string, question: string, payload?: object) {
  const { error } = await db.from("ai_requests").insert({ requested_by: me.id, requester_name: first(me), kind, summary: summary.slice(0, 300), question: question.slice(0, 2000), payload: payload ?? null });
  return !error;
}

export async function askDashboard(db: SupabaseClient, me: Profile, history: Turn[], question: string, opts: Opts = {}) {
  const director = me.role === "director";
  // daily limit for staff (keeps the AI bill in check); Ronan isn't limited
  if (!director && !opts.noLimit) {
    const since = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z").toISOString();
    const { count } = await db.from("ai_log").select("id", { count: "exact", head: true }).eq("user_id", me.id).gte("at", since);
    if ((count ?? 0) >= DAILY_LIMIT) {
      await requestApproval(db, me, "over_limit", `More questions today (over ${DAILY_LIMIT})`, question);
      return `You've reached today's limit of ${DAILY_LIMIT} questions. I've asked Ronan; if he approves, the answer will appear under "Waiting for Ronan" on the Ask page.`;
    }
  }
  const client = new Anthropic();
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
  const scope = director || opts.approvedOffTopic ? "" : `

Only help with Beamore's work: its projects, clients, clerks, invoices, reports, diary, to-dos, construction and clerk of works knowledge, and writing work emails or documents. If the request is anything else (personal projects, general chat, homework, unrelated coding or writing), or you're unsure, do NOT answer it: call request_permission with a short summary, then tell them you've asked Ronan.`;
  const system = `You answer questions and get work done for the team at Beamore Management Ltd, a UK clerk of works consultancy (construction quality inspections, many on DfE school projects). You are inside their dashboard. Today is ${today}. You're talking to ${me.full_name ?? me.email} (${director ? "the director, Ronan" : "a member of staff"}).

You can see everything about the business: projects, clients, clerks of works (contacts, compliance, holidays, diary, where they work), clerk of works reports (scores, issues, status) and to-dos. Use "reports" and "report_scores" for reports, and "lookup" for anything the other tools don't cover. Private financials (margins, rates, costs, profit) are for Ronan only.${director ? "" : " If asked for those, say they're Ronan's to share."} People's names are often written differently (Andy / Andrew Collier, A M Marris, Christian M. Tate, Tony / Antony Larkins): treat close matches as the same person and combine their figures, saying which names you combined; only keep them apart if something shows they're different people. report_scores already combines them. Give report scores out of 100 only (e.g. 78/100), never out of 10. Report scores are for the office: never put them in anything for a clerk.
Look things up with the tools before answering; never guess facts. Answer in plain British English, short and direct: lead with the answer, then the key details. Use project names with their numbers (e.g. "Lydiate 1104") and people's names. When it helps, end with a link to the page in the dashboard (the 'link' field, e.g. /projects/abc). If the data doesn't say, say so.
You can also do things with the action tools (add or tick off to-dos, add project notes, set clerks, mark information received, mark jobs won or lost, save email drafts). Only do what was asked; confirm what you did in one line. Emails are only ever saved as drafts for Ronan to send.${scope}`;
  const messages: Anthropic.MessageParam[] = [
    ...history.slice(-10).map((t) => ({ role: t.role, content: t.text }) as Anthropic.MessageParam),
    { role: "user", content: question },
  ];
  const tools = TOOLS.filter((x) => (director ? x.name !== "request_permission" : x.name !== "search_email" && (!opts.approvedOffTopic || x.name !== "request_permission")));
  const done: { tool: string; input: unknown; result: unknown }[] = [];
  const finish = async (text: string) => {
    await db.from("ai_log").insert({ user_id: me.id, question: question.slice(0, 2000), actions: done });
    return text;
  };
  for (let step = 0; step < 8; step++) {
    const res = await client.messages.create({ model: AI_MODEL, max_tokens: 3000, system, tools, messages, output_config: { effort: "low" } } as Anthropic.MessageCreateParamsNonStreaming);
    if (res.stop_reason !== "tool_use") {
      return finish(res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("\n").trim() || "Sorry, I couldn't find an answer.");
    }
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of res.content) {
      if (b.type !== "tool_use") continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      let out: unknown;
      try {
        if (b.name === "request_permission") {
          out = (await requestApproval(db, me, "off_topic", String(input.summary ?? question), question)) ? { done: "Sent to Ronan for permission" } : { error: "Couldn't send the request" };
        } else if (!director && NEEDS_RONAN.has(b.name)) {
          const what = b.name === "draft_email" ? `Email draft to ${input.to}: "${input.subject}"` : `Mark project ${input.number} as ${input.outcome}`;
          out = (await requestApproval(db, me, "action", what, question, { tool: b.name, input })) ? { done: "Sent to Ronan to approve; it will happen when he approves" } : { error: "Couldn't send the request" };
        } else {
          out = await run(db, me, b.name, input);
          if (ACTIONS.has(b.name)) done.push({ tool: b.name, input, result: out });
        }
      } catch (e) { out = { error: e instanceof Error ? e.message : "lookup failed" }; }
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out).slice(0, 40000) });
    }
    messages.push({ role: "user", content: results });
  }
  return finish("That needed more steps than I can do in one go. Could you ask something narrower?");
}
