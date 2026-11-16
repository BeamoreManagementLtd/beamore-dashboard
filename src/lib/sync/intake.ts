import "server-only";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { INFO_DFE, INFO_STANDARD } from "@/lib/project-info";
import { ensureProjectFolder, saveProjectAttachments, onWon } from "@/lib/project-setup";
import { loadWorkflows, WORKFLOW_COLUMNS, type WorkflowProject } from "@/lib/workflow";
import { appendToRegister } from "@/lib/sync/register-sync";

/**
 * Project intake (hourly, read only):
 *  1. Decide whether each live/won project is a DfE job, with the evidence: cheapest first (dashboard data,
 *     then your Gmail about the project, then the cost proposal document in Drive).
 *  2. When a project starts (stage moves to Won/Live from now on, or a new project appears), start the DfE or
 *     standard checklist automatically and log why.
 *  3. For checklist items still outstanding, search email about the project and attach a "possibly in" hint.
 *  4. Spot replies to cost proposals that read like a go-ahead and put them on the director's due list.
 * Never sends or changes email; never changes a project's stage.
 */
const STARTING = ["won_arranging", "won_preparing", "live"];
const STRONG = [/\bDfE\b/, /department for education/i, /education\.gov\.uk/i, /\bSRP\s?\d{3,4}\b/i, /school rebuilding programme/i, /\bTAS\s?2[15]\b/i];
// a school-type name with no DfE signs is a question for the director, not a "no"
const SCHOOLISH = /(school|academy|college|primary|high|grammar|sixth form|infant|junior|SEN)/i;
const MEDIUM = [/\bCQM\b/, /construction quality monitor/i, /technical advis[eo]r/i, /\bDfE CoW\b/i];

export function classifyDfe(texts: { source: string; text: string }[]) {
  const hits: string[] = [];
  let score = 0;
  for (const { source, text } of texts) {
    for (const re of STRONG) { const m = re.exec(text); if (m) { score += 2; hits.push(`"${m[0]}" in ${source}`); } }
    for (const re of MEDIUM) { const m = re.exec(text); if (m) { score += 1; hits.push(`"${m[0]}" in ${source}`); } }
  }
  return { dfe: score >= 2, score, evidence: [...new Set(hits)].slice(0, 4).join("; ") };
}

// what to look for in email for each checklist item
const ITEM_SEARCH: [RegExp, string][] = [
  [/programme/i, "programme OR schedule"],
  [/CPs/i, '"construction proposals" OR CPs OR wetransfer'],
  [/\bPO\b/i, '"purchase order" OR "PO number" OR "PO no"'],
  [/distribution list/i, '"distribution list" OR "send reports to" OR "circulation list"'],
  [/DfE project number/i, '"DfE project number" OR "project number"'],
  [/DfE project director/i, '"project director"'],
  [/DfE project manager/i, '"project manager" DfE'],
  [/TA name/i, '"technical adviser" OR "technical advisor"'],
  [/Principal contractor project manager/i, '"project manager" contractor'],
  [/Principal contractor project number/i, '"contract number" OR "job number"'],
  [/drawings|specification/i, "drawings OR specification OR spec"],
  [/site contacts|address/i, '"site address" OR "site manager"'],
  [/contact info/i, "contact OR mobile"],
];

type Msg = { id: string; threadId: string; internalDate: string; snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
const header = (m: Msg, n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
const who = (from: string) => (/^"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? from).trim();

export async function runIntake(admin: SupabaseClient) {
  const { data: run } = await admin.from("sync_runs").insert({ source: "intake" }).select("id").single();
  const finish = (ok: boolean, message: string) => admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const g = await driveClient(admin);
    const q = (query: string, max = 5) => g.gmail<{ messages?: { id: string; threadId: string }[] }>("messages", { q: query, maxResults: String(max) });
    const msg = (id: string) => g.gmail<Msg>(`messages/${id}`, { format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject"] });
    const quoted = (name: string) => `"${name.replace(/"/g, "")}"`;

    const { data: projects } = await admin.from("projects")
      .select("id,number,name,display_name,stage,is_dfe,dfe_evidence,stage_changed_at,proposal_folder,diary_aliases")
      .in("stage", [...STARTING, "sent", "pricing", "enquiry"]);
    let classified = 0, started = 0, hinted = 0, goAheads = 0;

    // ---- 1. DfE or not, for live/won projects not yet decided
    // newly started projects first; the backlog of existing live jobs is spread over a few hourly runs
    const undecided = (projects ?? []).filter((p) => p.is_dfe == null && !p.dfe_evidence?.startsWith("Unsure"))
      .sort((a, b) => (b.stage_changed_at ? 1 : 0) - (a.stage_changed_at ? 1 : 0)).slice(0, 25);
    for (const p of undecided) {
      const texts: { source: string; text: string }[] = [{ source: "project name", text: `${p.name} ${p.diary_aliases.join(" ")}` }];
      const [{ data: inv }, { data: rq }, { data: rl }] = await Promise.all([
        admin.from("invoices").select("reference").eq("project_id", p.id).limit(20),
        admin.from("report_queue").select("report_name").eq("project_id", p.id).limit(20),
        admin.from("report_log").select("report_name").eq("project_id", p.id).limit(20),
      ]);
      texts.push({ source: "invoices", text: (inv ?? []).map((i) => i.reference).join(" ") });
      texts.push({ source: "report names", text: [...(rq ?? []), ...(rl ?? [])].map((r) => r.report_name).join(" ") });
      let c = classifyDfe(texts);
      if (!c.dfe) { // your email about the project
        // name in the subject only: a body match on a generic name ("Manchester", "Costs") pulls in other jobs' emails
        const found = await q(`subject:${quoted(p.name)} newer_than:2y`, 4);
        for (const m of found.messages ?? []) {
          const full = await msg(m.id);
          texts.push({ source: `email "${header(full, "Subject").slice(0, 60)}"`, text: `${header(full, "To")} ${header(full, "Cc")} ${header(full, "From")} ${header(full, "Subject")} ${full.snippet ?? ""}` });
        }
        c = classifyDfe(texts);
      }
      if (!c.dfe) { // the cost proposal document
        const { files } = await g.json<{ files: { id: string; name: string }[] }>("files", {
          q: `name contains '${p.name.replace(/'/g, "\\'")}' and (name contains 'proposal' or name contains 'Proposal') and mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' and trashed = false`,
          fields: "files(id,name)", pageSize: "2", orderBy: "modifiedTime desc",
        });
        if (files[0]) {
          const zip = await JSZip.loadAsync(await g.download(files[0].id));
          const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
          texts.push({ source: `proposal "${files[0].name}"`, text: xml.replace(/<[^>]+>/g, " ") });
          c = classifyDfe(texts);
        }
      }
      const unsure = !c.dfe && (c.score === 1 || SCHOOLISH.test(`${p.name} ${p.display_name}`));
      await admin.from("projects").update(c.dfe
        ? { is_dfe: true, dfe_evidence: c.evidence }
        : unsure
          ? { is_dfe: null, dfe_evidence: `Unsure: ${c.score === 1 ? `only a weak sign (${c.evidence})` : "sounds like a school but no DfE signs found"}` }
          : { is_dfe: false, dfe_evidence: "No DfE signs in the project's name, invoices, reports, recent emails or proposal" }).eq("id", p.id);
      classified++;
    }

    // ---- 2. every won/live project gets the right checklist (DfE or standard) without anyone clicking.
    // Jobs already running before the dashboard: the client sent all this long ago, so the items are ticked as
    // "assumed received" (untick any that are really missing) instead of being chased.
    const { data: fresh } = await admin.from("projects").select("id,display_name,is_dfe,dfe_evidence,stage,stage_changed_at")
      .in("stage", STARTING).not("is_dfe", "is", null);
    // read every row: past 1,000 the checklist was added again each hour (16 Nov 2026: Kings Maths had it 12 times)
    const listed = new Set<string>();
    for (let from = 0; ; from += 1000) {
      const { data: page, error: pageErr } = await admin.from("project_info").select("project_id").order("id").range(from, from + 999);
      if (pageErr) throw new Error(`checklists: ${pageErr.message}`);
      for (const h of page ?? []) listed.add(h.project_id as string);
      if ((page?.length ?? 0) < 1000) break;
    }
    for (const p of fresh ?? []) {
      if (listed.has(p.id)) continue;
      const list = p.is_dfe ? INFO_DFE : INFO_STANDARD;
      const running = !p.stage_changed_at && p.stage === "live";
      const today = new Date().toISOString().slice(0, 10);
      await admin.from("project_info").insert(list.map((item) => ({ project_id: p.id, item, auto: true,
        ...(running ? { received_on: today, note: "Assumed received: the project was running before the dashboard" } : {}) })));
      await admin.from("project_events").insert({ project_id: p.id, source: "dashboard", kind: "Checklist started", who: "Dashboard",
        body: (running
          ? `${p.is_dfe ? "DfE" : "Standard"} checklist added. The job was already running, so every item is ticked as received; untick any that are missing and they'll be chased.`
          : `${p.is_dfe ? "DfE" : "Standard"} checklist started automatically when the project started.`) + (p.is_dfe ? ` Why DfE: ${p.dfe_evidence}` : "") });
      started++;
    }

    // ---- 3. outstanding checklist items: look for them in email about the project
    const { data: open } = await admin.from("project_info").select("id,item,project_id,hint_at,projects(name)").is("received_on", null).limit(60);
    for (const i of open ?? []) {
      if (i.hint_at && Date.now() - Date.parse(i.hint_at) < 24 * 3600e3) continue; // at most daily per item
      const name = (i.projects as unknown as { name: string } | null)?.name;
      const terms = ITEM_SEARCH.find(([re]) => re.test(i.item))?.[1];
      if (!name || !terms) continue;
      const found = await q(`${quoted(name)} (${terms}) -from:me newer_than:180d`, 1);
      const m = found.messages?.[0];
      if (m) {
        const full = await msg(m.id);
        const when = new Date(Number(full.internalDate)).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        await admin.from("project_info").update({ hint: `"${header(full, "Subject").slice(0, 80)}" from ${who(header(full, "From"))}, ${when}`, hint_thread: full.threadId, hint_at: new Date().toISOString() }).eq("id", i.id);
        hinted++;
      } else await admin.from("project_info").update({ hint_at: new Date().toISOString() }).eq("id", i.id);
    }

    // ---- 3b. pricing workflow: proposal gone out (P3) and client replied (P4), for projects started since workflows began
    let sentFound = 0, replies4 = 0;
    for (const p of (projects ?? []).filter((x) => x.stage_changed_at && ["enquiry", "pricing", "sent"].includes(x.stage))) {
      const since = Math.floor(Date.parse(p.stage_changed_at!) / 1000);
      if (p.stage !== "sent") {
        const found = await q(`in:sent subject:${quoted(p.name)} (proposal OR fee OR quote OR quotation) after:${since}`, 1);
        const m = found.messages?.[0];
        if (!m) continue;
        const full = await msg(m.id);
        await admin.from("projects").update({ stage: "sent" }).eq("id", p.id);
        await admin.from("project_events").insert({ project_id: p.id, source: "gmail", kind: "Email sent", who: "You",
          body: `Proposal found in sent email: "${header(full, "Subject").slice(0, 120)}" to ${header(full, "To").slice(0, 120)}` });
        sentFound++;
      } else {
        const { count } = await admin.from("project_steps").select("step", { count: "exact", head: true }).eq("project_id", p.id).eq("step", "P4");
        if (count) continue;
        const found = await q(`subject:${quoted(p.name)} -from:me -subject:"automatic reply" -subject:"out of office" after:${since}`, 1);
        const m = found.messages?.[0];
        if (!m) continue;
        const full = await msg(m.id);
        const from = who(header(full, "From"));
        await admin.from("project_steps").upsert({ project_id: p.id, step: "P4", done_by: from, done_at: new Date(Number(full.internalDate)).toISOString(), note: m.threadId });
        await admin.from("project_events").insert({ project_id: p.id, source: "gmail", kind: "Email received", who: from,
          body: `Reply to the proposal: "${header(full, "Subject").slice(0, 120)}": ${(full.snippet ?? "").slice(0, 200)}` });
        replies4++;
      }
    }

    // ---- 3c. won projects: retry the folder / draft if Google wasn't ready; notice the info request going out (S2)
    let setupDone = 0, requestsSent = 0;
    const { data: wonNow } = await admin.from("projects").select("id,name,drive_folder_id").in("stage", ["won_arranging", "won_preparing"]).not("stage_changed_at", "is", null);
    for (const p of wonNow ?? []) {
      if (!p.drive_folder_id) {
        // won some other way than the Won button (stage changed on the project, or here): run the whole set-up once
        const { count: drafted } = await admin.from("project_events").select("id", { count: "exact", head: true }).eq("project_id", p.id).in("kind", ["Info request drafted", "Set-up problem"]);
        try { if (drafted) await ensureProjectFolder(admin, p.id); else await onWon(admin, p.id); setupDone++; } catch { /* logged; try again next hour */ }
      }
      const { data: drafted } = await admin.from("project_events").select("happened_at").eq("project_id", p.id).eq("kind", "Info request drafted").order("happened_at", { ascending: false }).limit(1);
      const { count: waiting } = await admin.from("project_info").select("id", { count: "exact", head: true }).eq("project_id", p.id).is("requested_on", null).is("received_on", null);
      if (!drafted?.[0] || !waiting) continue;
      const since = Math.floor(Date.parse(drafted[0].happened_at) / 1000) - 60;
      const sent = await q(`in:sent subject:${quoted(p.name)} after:${since}`, 1);
      if (!sent.messages?.length) continue;
      const day = new Date().toISOString().slice(0, 10);
      await admin.from("project_info").update({ requested_on: day }).eq("project_id", p.id).is("requested_on", null).is("received_on", null);
      await admin.from("project_events").insert({ project_id: p.id, source: "gmail", kind: "Info requested", who: "You", body: "Request for project information sent (found in sent email)" });
      requestsSent++;
    }

    // ---- 3f. won jobs: set-up finished → "waiting to start on site"; a charged day in the diary → started (Live)
    let readyToStart = 0, startedOnSite = 0;
    {
      const { data: won } = await admin.from("projects").select(`${WORKFLOW_COLUMNS},display_name`).in("stage", ["won_arranging", "won_preparing"]);
      const list = (won ?? []) as unknown as (WorkflowProject & { display_name: string })[];
      const wfs = await loadWorkflows(admin, list);
      const { data: vs } = await admin.from("project_visit_summary").select("project_id,last_visit,charged_visits").in("project_id", list.map((p) => p.id));
      for (const p of list) {
        const v = (vs ?? []).find((x) => x.project_id === p.id);
        const since = (p.stage_changed_at ?? "").slice(0, 10);
        if (v && v.charged_visits > 0 && v.last_visit && (!since || v.last_visit >= since)) {
          await admin.from("projects").update({ stage: "live", ...(p.start_date ? {} : { start_date: v.last_visit }) }).eq("id", p.id);
          await admin.from("project_events").insert({ project_id: p.id, source: "dashboard", kind: "Started on site", who: "Dashboard", body: `Started on site: charged days in the diary (latest ${v.last_visit})` });
          startedOnSite++;
        } else if (p.stage === "won_arranging" && wfs.get(p.id)?.current === "start") {
          await admin.from("projects").update({ stage: "won_preparing" }).eq("id", p.id);
          await admin.from("project_events").insert({ project_id: p.id, source: "dashboard", kind: "Set-up done", who: "Dashboard", body: `Set-up finished. Waiting to start on site${p.start_date ? ` (${p.start_date})` : ""}` });
          readyToStart++;
        }
      }
    }

    // ---- 3d. S5: client attachments into the project's Drive folder
    let filesSaved = 0;
    {
      const { data: withFolder } = await admin.from("projects").select("id").in("stage", ["won_arranging", "won_preparing", "live"]).not("stage_changed_at", "is", null).not("drive_folder_id", "is", null);
      for (const p of withFolder ?? []) { try { filesSaved += await saveProjectAttachments(admin, p.id); } catch { /* try again next hour */ } }
    }

    // ---- 3e. people applying to work for us (Indeed adverts, direct emails) → Find a clerk
    let applicants = 0;
    {
      const apps = await q('-from:me newer_than:30d (subject:"new application for" OR subject:(application ("clerk of works" OR CoW OR CQM OR inspector)))', 40);
      const { data: known } = await admin.from("job_applications").select("message_id");
      const have = new Set((known ?? []).map((k) => k.message_id));
      const { data: all } = await admin.from("projects").select("id,name,stage,clerk_id,clerk_status").not("stage", "in", "(lost,complete)");
      for (const m of apps.messages ?? []) {
        if (have.has(m.id)) continue;
        const full = await msg(m.id);
        const subj = header(full, "Subject"), from = header(full, "From");
        if (/^re:/i.test(subj) && !/indeed/i.test(from)) continue; // a reply in a conversation, not a new application
        const indeed = /indeed/i.test(from);
        const name = (indeed ? /^(.+?) applied/.exec(full.snippet ?? "")?.[1] : who(from))?.replace(/\s+/g, " ").trim();
        if (!name) continue;
        const ad = /new application for (.+?),\s*(.+)$/i.exec(subj);
        const role = ad?.[1] ?? (/clerk of works/i.test(subj) ? "Clerk of Works" : /CQM/i.test(subj) ? "CQM" : null);
        const location = ad?.[2]?.trim() ?? null;
        const where = `${location ?? ""} ${subj}`.toLowerCase();
        const job = (all ?? []).filter((p) => p.name.length > 3 && where.includes(p.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
        const replyTo = (/<([^>]+)>/.exec(header(full, "Reply-To") || from)?.[1] ?? from).trim();
        const { data: row } = await admin.from("job_applications").insert({ message_id: m.id, thread_id: m.threadId, name: name.slice(0, 120), reply_to: replyTo,
          role, location, source: indeed ? "Indeed" : "email", received_at: new Date(Number(full.internalDate)).toISOString(), project_id: job?.id ?? null }).select("id").single();
        // the job is already looking for a clerk: straight onto its list as "applied"
        if (row && job && job.clerk_status === "finding" && !job.clerk_id) {
          await admin.from("clerk_candidates").insert({ project_id: job.id, name: name.slice(0, 120), status: "applied", application_id: row.id, note: `Applied via ${indeed ? "Indeed" : "email"}` });
          await admin.from("job_applications").update({ status: "added" }).eq("id", row.id);
        }
        applicants++;
      }
    }

    // ---- 5. P1: emails that look like a request to price; the director is asked before anything is created
    let priceRequests = 0;
    {
      // must ask for a price: "clerk of works" or "CQM" alone is in half your email (reports, applications, adverts)
      // tenders too (Ronan, 16 Nov 2026: "Tender Enquiry-T1121-Compton Property-Leo House-Clerk of Works" was missed)
      const asks = await q('-from:me -in:chats newer_than:3d (subject:("fee proposal" OR "fee request" OR "request for fee" OR "fee quote" OR quote OR quotation OR "request for proposal" OR "pricing" OR tender OR "tender enquiry" OR "invitation to tender" OR ITT OR RFQ OR "request for quotation" OR "fee enquiry" OR "price request") OR "invitation to tender" OR "tender return" OR "please provide a fee" OR "provide a fee" OR "provide a quote" OR "fee proposal for" OR "could you price" OR "can you price" OR "your fee for" OR "send us a fee") -subject:(application OR applied OR CV OR vacancy OR job OR "saved search" OR competency OR invoice OR report)', 25);
      const { data: known } = await admin.from("price_requests").select("message_id,thread_id");
      const seen = new Set((known ?? []).flatMap((k) => [k.message_id, k.thread_id]));
      const { data: contacts } = await admin.from("invoice_contacts").select("client_id,to_emails").not("client_id", "is", null);
      const domainClient = new Map<string, string>();
      for (const c of contacts ?? []) for (const e of (c.to_emails as string[]) ?? []) { const d = e.split("@")[1]?.toLowerCase(); if (d && !/gmail|outlook|hotmail|yahoo|icloud/.test(d)) domainClient.set(d, c.client_id as string); }
      for (const m of asks.messages ?? []) {
        if (seen.has(m.id) || seen.has(m.threadId)) continue;
        const full = await msg(m.id);
        const subj = header(full, "Subject"), from = header(full, "From");
        if (/^(automatic reply|out of office|undeliverable|accepted:|declined:)/i.test(subj) || /noreply|no-reply|donotreply|notifications?@|alerts?@|mailer-daemon|beamore\.co\.uk|indeed|findatender|find\.a\.tender|notifications\.service\.gov\.uk|contractsfinder|linkedin/i.test(from)) continue;
        // about a job we already have (report, invoice, chaser) rather than a new one to price
        if (/\b(report|diary|invoice|remittance|payment|timesheet)\b/i.test(subj)) continue;
        if ((projects ?? []).some((p) => p.name.length > 4 && subj.toLowerCase().includes(p.name.toLowerCase()) && !["enquiry", "pricing"].includes(p.stage))) continue;
        const email = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
        const { error: saveErr } = await admin.from("price_requests").insert({ message_id: m.id, thread_id: m.threadId, from_name: who(from), from_email: email, subject: subj.slice(0, 300),
          snippet: (full.snippet ?? "").slice(0, 400), received_at: new Date(Number(full.internalDate)).toISOString(), client_id: domainClient.get(email.split("@")[1] ?? "") ?? null });
        seen.add(m.threadId);
        if (!saveErr) priceRequests++;
      }
    }

    // ---- 6. new projects get their row (BM number) in the Cost Proposals Register
    let registerRows = 0;
    try { registerRows = await appendToRegister(admin); } catch { /* try next hour */ }

    // ---- 4. replies to cost proposals that look like a go-ahead (logged once per message)
    const replies = await q('(subject:proposal OR subject:"fee") (instruct OR "go ahead" OR "pleased to confirm" OR "happy to proceed" OR appoint OR "purchase order") -from:me newer_than:14d', 20);
    for (const m of replies.messages ?? []) {
      const full = await msg(m.id);
      const subj = header(full, "Subject");
      const proj = (projects ?? []).find((p) => !STARTING.includes(p.stage) && subj.toLowerCase().includes(p.name.toLowerCase()));
      if (!proj) continue;
      const { count } = await admin.from("project_events").select("id", { count: "exact", head: true }).eq("project_id", proj.id).eq("kind", "Possible go-ahead").ilike("body", `%${m.id}%`);
      if (count) continue;
      await admin.from("project_events").insert({ project_id: proj.id, source: "gmail", kind: "Possible go-ahead",
        who: who(header(full, "From")), body: `"${subj}": ${(full.snippet ?? "").slice(0, 200)} [${m.id}]` });
      goAheads++;
    }

    const msgText = `${classified} projects checked for DfE, ${started} checklists started, ${hinted} checklist items found in email, ${sentFound} proposals found sent, ${replies4} client replies, ${setupDone} folders made, ${requestsSent} info requests seen sent, ${filesSaved} attachments saved to Drive, ${applicants} job applications, ${readyToStart} ready to start, ${startedOnSite} started on site, ${goAheads} possible go-aheads, ${priceRequests} possible pricing requests, ${registerRows} added to the register`;
    await finish(true, msgText);
    return { ok: true, message: msgText };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await finish(false, m);
    return { ok: false, message: m };
  }
}
