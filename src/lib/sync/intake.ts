import "server-only";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { INFO_DFE, INFO_STANDARD } from "@/lib/project-info";

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

    // ---- 2. projects that started since the automation began: start the right checklist
    const { data: fresh } = await admin.from("projects").select("id,display_name,is_dfe,dfe_evidence,stage")
      .in("stage", STARTING).not("stage_changed_at", "is", null).not("is_dfe", "is", null);
    for (const p of fresh ?? []) {
      const { count } = await admin.from("project_info").select("id", { count: "exact", head: true }).eq("project_id", p.id);
      if (count) continue;
      const list = p.is_dfe ? INFO_DFE : INFO_STANDARD;
      await admin.from("project_info").insert(list.map((item) => ({ project_id: p.id, item, auto: true })));
      await admin.from("project_events").insert({ project_id: p.id, source: "dashboard", kind: "Checklist started",
        who: "Dashboard", body: `${p.is_dfe ? "DfE" : "Standard"} checklist started automatically when the project started. ${p.is_dfe ? `Why DfE: ${p.dfe_evidence}` : ""}`.trim() });
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

    const msgText = `${classified} projects checked for DfE, ${started} checklists started, ${hinted} checklist items found in email, ${goAheads} possible go-aheads`;
    await finish(true, msgText);
    return { ok: true, message: msgText };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    await finish(false, m);
    return { ok: false, message: m };
  }
}
