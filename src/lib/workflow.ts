import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A project's workflow (docs/workflows.html): every step's state worked out from live data where we can
 * (diary, Xero invoices, reports, the info checklist, email) and from steps ticked by hand.
 */
export type StepState = "done" | "now" | "todo" | "skip";
export type Step = { id: string; title: string; state: StepState; note?: string; manual?: boolean; how?: "auto" | "button" | "task" };
export type Stage = { key: "pricing" | "setup" | "live" | "closeout"; title: string; steps: Step[]; state: StepState };

type P = {
  id: string; stage: string; is_dfe: boolean | null; dfe_evidence: string | null; created_at: string; stage_changed_at: string | null;
  clerk_id: string | null; clerk_status: string | null; po_number: string | null; drive_folder_id: string | null; lost_reason: string | null;
};

const PRICING = ["enquiry", "pricing", "sent"];
const WON = ["won_arranging", "won_preparing"];
const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "");

export async function loadWorkflow(db: SupabaseClient, p: P): Promise<{ stages: Stage[]; current: Stage["key"] | "lost" | "complete"; ticked: string[] }> {
  const [{ data: steps }, { data: info }, { data: visits }, { data: inv }, { data: rq }, { data: rl }, { data: clerk }, { data: contacts }] = await Promise.all([
    db.from("project_steps").select("step,done_at,done_by,note").eq("project_id", p.id),
    db.from("project_info").select("item,requested_on,received_on").eq("project_id", p.id),
    db.from("diary_visits").select("visit_date,side,clerks(name)").eq("project_id", p.id).order("visit_date", { ascending: false }).limit(200),
    db.from("invoices").select("issued,amount_due,status").eq("project_id", p.id).order("issued", { ascending: false }).limit(50),
    db.from("report_queue").select("report_name").eq("project_id", p.id).limit(1),
    db.from("report_log").select("report_date").eq("project_id", p.id).order("report_date", { ascending: false }).limit(1),
    p.clerk_id ? db.from("clerks").select("name").eq("id", p.clerk_id).maybeSingle() : Promise.resolve({ data: null }),
    db.from("invoice_contacts").select("label").eq("project_id", p.id).limit(1),
  ]);
  const manual = new Map((steps ?? []).map((s) => [s.step, s]));
  const by = (id: string) => { const m = manual.get(id); return m ? `${m.done_by ?? "ticked"}, ${fmt(m.done_at)}` : undefined; };
  // projects already running before workflows existed: hand-only set-up steps count as done
  const legacy = !p.stage_changed_at && !PRICING.includes(p.stage) && !WON.includes(p.stage);

  const live = (inv ?? []).filter((i) => i.status !== "VOIDED" && i.status !== "DELETED");
  const outstanding = live.reduce((a, i) => a + Number(i.amount_due ?? 0), 0);
  const charged = (visits ?? []).filter((v) => v.side !== "planned");
  const clerkNames = [...new Set((visits ?? []).map((v) => (v.clerks as unknown as { name: string } | null)?.name).filter(Boolean))].slice(0, 3);
  const infoIn = (info ?? []).filter((i) => i.received_on).length;
  const poItem = (info ?? []).find((i) => /\bPO\b/.test(i.item));

  const pastPricing = !PRICING.includes(p.stage);
  const won = !PRICING.includes(p.stage) && p.stage !== "lost";
  const step = (id: string, title: string, done: boolean, note?: string, opts: Partial<Step> = {}): Step =>
    ({ id, title, state: done || manual.has(id) ? "done" : "todo", note: done ? note : by(id) ?? note, ...opts });

  const pricing: Step[] = [
    step("P1", "Request to price received", true, legacy ? undefined : fmt(p.created_at), { how: "auto" }),
    { ...step("P2", "DfE or not", p.is_dfe != null, p.is_dfe == null ? undefined : p.is_dfe ? "DfE" : "Not DfE", { how: "auto" }),
      note: p.is_dfe == null && p.dfe_evidence?.startsWith("Unsure") ? "Question waiting for you" : p.is_dfe == null ? undefined : p.is_dfe ? "DfE" : "Not DfE" },
    step("P3", "Cost proposal sent", p.stage === "sent" || pastPricing, undefined, { manual: true, how: "button" }),
    step("P4", "Client replied", pastPricing, undefined, { manual: true, how: "auto" }),
    step("P5", "Won or lost", pastPricing, p.stage === "lost" ? `Lost${p.lost_reason ? `: ${p.lost_reason}` : ""}` : "Won", { how: "button" }),
  ];

  const s = (id: string, title: string, done: boolean, note?: string, opts: Partial<Step> = {}) =>
    step(id, title, done || (legacy && !!opts.manual), done ? note : legacy && opts.manual ? "Before workflows started" : note, opts);
  const setup: Step[] = [
    s("S1", `${p.is_dfe ? "DfE" : "Standard"} checklist`, (info ?? []).length > 0, `${(info ?? []).length} items`, { how: "auto", manual: true }),
    s("S2", "Information requested from client", (info ?? []).some((i) => i.requested_on), `requested ${fmt((info ?? []).find((i) => i.requested_on)?.requested_on)}`, { manual: true, how: "task" }),
    s("S3", "Clerk of works", !!p.clerk_id || charged.length > 0,
      clerk?.name ?? (clerkNames.join(", ") || undefined), { how: "button" }),
    s("S4", "Google Drive folder", !!p.drive_folder_id, "created", { manual: true, how: "auto" }),
    s("S5", "Information received", (info ?? []).length > 0 && infoIn === (info ?? []).length,
      (info ?? []).length ? `${infoIn} of ${(info ?? []).length} received` : undefined, { manual: true, how: "auto" }),
    s("S6", "PO number", !!p.po_number || !!poItem?.received_on, p.po_number ?? "received", { manual: true, how: "auto" }),
    s("S7", "Set up in Xero", live.length > 0, "invoiced", { manual: true, how: "auto" }),
    s("S8", "Diary updated", (visits ?? []).length > 0 && ((contacts ?? []).length > 0 || legacy), "in the diary", { manual: true, how: "task" }),
    s("S9", "Report tracker", (rq ?? []).length + (rl ?? []).length > 0, "in the tracker", { manual: true, how: "task" }),
    s("S10", "Live", ["live", "on_hold", "complete"].includes(p.stage), undefined, { how: "auto" }),
  ];
  // S3 note when not done
  if (setup[2].state !== "done" && p.clerk_status === "finding") setup[2].note = "Finding a clerk";
  if (setup[4].state !== "done" && (info ?? []).length) setup[4].note = `${infoIn} of ${(info ?? []).length} received`;

  const lastVisit = (visits ?? []).find((v) => v.side !== "planned")?.visit_date;
  const lastInv = live[0]?.issued;
  const liveSteps: Step[] = [
    step("L1", "Site visits", !!lastVisit, `last ${fmt(lastVisit)}`, { how: "auto" }),
    step("L2", "Reports", (rl ?? []).length > 0, `last ${fmt(rl?.[0]?.report_date)}`, { how: "auto" }),
    step("L3", "Invoiced", !!lastInv, `last ${fmt(lastInv)}`, { how: "auto" }),
  ];

  const prevMonth = new Date(); prevMonth.setDate(1); prevMonth.setMonth(prevMonth.getMonth() - 1);
  const prevMonthStart = prevMonth.toISOString().slice(0, 10);
  const quiet = p.stage === "live" && !!lastInv && lastInv < prevMonthStart;
  const x2 = manual.get("X2");
  const closeout: Step[] = [
    { id: "X1", title: "A month with no invoice", how: "auto", state: quiet || p.stage === "on_hold" || p.stage === "complete" || x2 ? "done" : "todo", note: lastInv ? `last invoice ${fmt(lastInv)}` : undefined },
    { id: "X2", title: "Finished, paused or still going?", how: "button", state: x2?.note === "finished" || p.stage === "complete" ? "done" : "todo", note: x2 ? `${x2.note}, ${x2.done_by ?? ""} ${fmt(x2.done_at)}` : p.stage === "on_hold" ? "Paused" : undefined },
    { id: "X3", title: "Paid in full", how: "auto", state: (x2?.note === "finished" || p.stage === "complete") && outstanding <= 0 ? "done" : "todo",
      note: outstanding > 0 ? `£${outstanding.toLocaleString("en-GB", { maximumFractionDigits: 0 })} outstanding` : undefined },
    { id: "X4", title: "Complete", how: "auto", state: p.stage === "complete" ? "done" : "todo" },
  ];

  const current: Stage["key"] | "lost" | "complete" =
    p.stage === "lost" ? "lost" : p.stage === "complete" ? "complete" : PRICING.includes(p.stage) ? "pricing" : WON.includes(p.stage) ? "setup"
      : p.stage === "on_hold" || quiet || (x2 && x2.note !== "going") ? "closeout" : "live";
  const order = ["pricing", "setup", "live", "closeout"] as const;
  const idx = current === "lost" ? 0 : current === "complete" ? 4 : order.indexOf(current);
  const stages: Stage[] = [
    { key: "pricing", title: "Pricing", steps: pricing, state: "todo" },
    { key: "setup", title: "Set-up", steps: setup, state: "todo" },
    { key: "live", title: "Live", steps: liveSteps, state: "todo" },
    { key: "closeout", title: "Close-out", steps: closeout, state: "todo" },
  ];
  stages.forEach((st, i) => {
    st.state = current === "lost" ? (i === 0 ? "done" : "skip") : i < idx ? "done" : i === idx ? "now" : "todo";
    // the first unfinished step of the current stage is the one we're waiting on
    if (st.state === "now") { const f = st.steps.find((x) => x.state === "todo"); if (f) f.state = "now"; }
  });
  if (current === "lost") stages.slice(1).forEach((st) => st.steps.forEach((x) => (x.state = "skip")));
  return { stages, current, ticked: [...manual.keys()] };
}
