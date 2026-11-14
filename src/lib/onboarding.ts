/**
 * New clerk onboarding (docs/workflows.html, workflow 4). Most steps tick themselves from the clerk's record
 * (contact details, document dates, the diary); the rest are ticked by hand and kept in onboarding_items by name.
 */
export type OnbState = "done" | "now" | "todo";
export type OnbStep = { id: string; title: string; state: OnbState; note?: string; tick?: string };
export type OnbGroup = { id: string; title: string; steps: OnbStep[] };

/** Ticked by hand (stored in onboarding_items.item). */
export const TICKS = {
  hat: "PPE: hard hat", boots: "PPE: safety boots", hivis: "PPE: hi-vis", glasses: "PPE: safety glasses", gloves: "PPE: gloves",
  rate: "Day rate agreed", template: "Report template and guidance sent", briefing: "Briefed on how we report", access: "System access set up",
  noChartership: "No chartership (not needed)",
} as const;
/** Kept for the old checklist button (any items already started stay as they are). */
export const ONBOARDING = Object.values(TICKS).filter((t) => t !== TICKS.noChartership);

export type OnbCompliance = {
  email?: string | null; phone?: string | null; address?: string | null; emergency_contact?: string | null; business_type?: string | null;
  bank_details_received?: string | null; pi_insurance_expiry?: string | null; pl_insurance_expiry?: string | null; cscs_expiry?: string | null;
  right_to_work_checked?: string | null; terms_signed?: string | null; dbs_status?: string | null; dbs_recheck?: string | null;
  chartership_body?: string | null; chartership_renewal?: string | null;
};

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");

export function buildOnboarding(c: OnbCompliance, ticked: Map<string, string | null>, hasDiaryRows: boolean, today: string) {
  const valid = (d?: string | null) => !!d && d >= today;
  const exp = (d?: string | null) => (d ? (d >= today ? `expires ${fmt(d)}` : `expired ${fmt(d)}`) : undefined);
  const tick = (id: string, title: string, name: string): OnbStep =>
    ({ id, title, tick: name, state: ticked.get(name) ? "done" : "todo", note: ticked.get(name) ? `ticked ${fmt(ticked.get(name))}` : undefined });
  const auto = (id: string, title: string, done: boolean, note?: string): OnbStep => ({ id, title, state: done ? "done" : "todo", note });
  const missing = [!c.email && "email", !c.phone && "phone", !c.address && "address", !c.emergency_contact && "emergency contact", !c.business_type && "limited company or sole trader"].filter(Boolean) as string[];

  const groups: OnbGroup[] = [
    { id: "O1", title: "Personnel record", steps: [
      auto("O1a", "Contact details, address, emergency contact, company type", !missing.length, missing.length ? `missing: ${missing.join(", ")}` : undefined),
      auto("O1b", "Bank details received (kept in Xero)", !!c.bank_details_received, c.bank_details_received ? fmt(c.bank_details_received) : undefined),
    ] },
    { id: "O2", title: "Documents", steps: [
      auto("O2a", "Professional indemnity insurance", valid(c.pi_insurance_expiry), exp(c.pi_insurance_expiry)),
      auto("O2b", "Public liability insurance", valid(c.pl_insurance_expiry), exp(c.pl_insurance_expiry)),
      auto("O2c", "DBS checked", c.dbs_status === "verified", c.dbs_recheck ? `recheck ${fmt(c.dbs_recheck)}` : c.dbs_status ?? undefined),
      auto("O2d", "CSCS card", valid(c.cscs_expiry), exp(c.cscs_expiry)),
      { ...auto("O2e", "Qualifications or chartership", !!c.chartership_body || ticked.has(TICKS.noChartership), c.chartership_body ?? (ticked.has(TICKS.noChartership) ? "not needed" : undefined)), tick: c.chartership_body ? undefined : TICKS.noChartership },
      auto("O2f", "Right to work checked", !!c.right_to_work_checked, c.right_to_work_checked ? fmt(c.right_to_work_checked) : undefined),
    ] },
    { id: "O3", title: "PPE", steps: [
      tick("O3a", "Hard hat", TICKS.hat), tick("O3b", "Safety boots", TICKS.boots), tick("O3c", "Hi-vis", TICKS.hivis),
      tick("O3d", "Safety glasses", TICKS.glasses), tick("O3e", "Gloves", TICKS.gloves),
    ] },
    { id: "O4", title: "Terms and rate", steps: [
      auto("O4a", "Terms signed", !!c.terms_signed, c.terms_signed ? fmt(c.terms_signed) : undefined),
      tick("O4b", "Day rate agreed (and on the diary’s Rates tab)", TICKS.rate),
    ] },
    { id: "O5", title: "Set up to report", steps: [
      auto("O5a", "Rows in the diary", hasDiaryRows, hasDiaryRows ? "seen in the diary" : "ticks itself when the diary sync sees them"),
      tick("O5b", "Report template and guidance sent", TICKS.template),
      tick("O5c", "Briefed on how we report", TICKS.briefing),
      tick("O5d", "System access set up", TICKS.access),
    ] },
  ];
  const all = groups.flatMap((g) => g.steps);
  const first = all.find((s) => s.state === "todo");
  if (first) first.state = "now";
  const done = all.filter((s) => s.state === "done").length;
  return { groups, done, total: all.length, complete: done === all.length, next: first };
}
