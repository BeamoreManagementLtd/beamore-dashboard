import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScorePart } from "./score";

/**
 * Example reports for clerks (Ronan, 19 Nov 2026: "an option for them to download the top 5 reports so they can see the
 * quality the top ones are getting, with some sort of a description"): the best-scoring sent reports of each kind, each
 * with a few plain words on why it scored well, taken from the marks the check already gave. Always current.
 */
export type ExampleKind = "diary" | "cqm" | "me";
export const EXAMPLE_KINDS: Record<ExampleKind, string> = { diary: "Clerk of works diary", cqm: "CQM report", me: "M&E report" };
const PER_KIND = 2;
/** Only reports that really are good make the list (M&E reports score lower so far: better none than a poor example). */
const MIN_SCORE = 75;

export type Example = { id: string; kind: ExampleKind; score: number; clerk: string; project: string; number: string | null; date: string | null; pdfName: string; why: string[] };

// by the file's name (the check's own "weekly CQM" flag also fires on DfE diaries that mention CQM)
const kindOf = (r: { kind: string; file_name: string; folder_name: string | null }): ExampleKind =>
  r.kind === "me" ? "me" : /\bCQM\b|Construction Quality Monitoring/i.test(`${r.file_name} ${r.folder_name ?? ""}`) ? "cqm" : "diary";

/** What it did well, from the parts that got (nearly) full marks: the strongest few, in plain words. */
function whyGood(parts: ScorePart[], programmeVerdict: string | null): string[] {
  const full = (p: ScorePart | undefined, share = 0.9) => !!p && p.got >= p.of * share;
  const by = (label: string) => parts.find((p) => p.label === label || (label === "Progress vs programme" && p.label === "Progress summary"));
  const out: string[] = [];
  const q = by("Quality of the information");
  if (full(q, 0.8)) out.push("Specific, detailed observations: where on site, what was seen, which trade, and what happens next");
  const photos = by("Photos"), n = /^(\d+) photo/.exec(photos?.note ?? "")?.[1];
  if (full(photos)) out.push(`${n ? `${n} clear photos` : "Plenty of clear photos"}, all the same size and covering what's described`);
  if (full(by("Health and safety items")) && !/not judged/.test(by("Health and safety items")?.note ?? "")) out.push("Every health and safety item filled in properly");
  if (programmeVerdict === "good" && full(by("Progress vs programme"))) out.push("Progress against the programme set out the Beamore way: activities, weeks ahead or behind, and a clear summary");
  if (full(by("Best practices"))) out.push("Follows the team's best practices");
  if (full(by("Issues tracker and file name"), 0.85)) out.push("Issues tracker kept up: each item dated, coloured and closed with a reason");
  if (full(by("Spelling and grammar"))) out.push("Hardly any spelling or grammar slips");
  return out.slice(0, 4);
}

/** The examples: the best {PER_KIND} of each kind, one per job, from reports sent with a PDF. */
export async function reportExamples(db: SupabaseClient): Promise<Example[]> {
  const { data } = await db.from("reports")
    .select("id,kind,score,file_name,folder_name,report_number,visit_date,uploaded_at,pdf_file_id,pdf_name,clerk_name,project_id,project_folder_name,fixes,clerks(name),projects(name)")
    .not("score", "is", null).not("pdf_file_id", "is", null).neq("status", "ignored").eq("fixes->>score_by", "parts")
    .order("score", { ascending: false }).order("visit_date", { ascending: false, nullsFirst: false }).limit(300);
  const out: Example[] = [];
  const jobsSeen = new Set<string>();
  for (const r of data ?? []) {
    const fx = (r.fixes ?? {}) as { score_parts?: ScorePart[]; programme?: { verdict?: string } | null };
    if (Number(r.score) < MIN_SCORE) break;
    const kind = kindOf(r);
    if (out.filter((e) => e.kind === kind).length >= PER_KIND) continue;
    const job = `${kind}:${r.project_id ?? r.project_folder_name ?? r.id}`;
    if (jobsSeen.has(job)) continue;
    jobsSeen.add(job);
    out.push({
      id: r.id, kind, score: Number(r.score),
      clerk: (r.clerks as unknown as { name?: string } | null)?.name ?? r.clerk_name ?? "",
      project: (r.projects as unknown as { name?: string } | null)?.name ?? r.project_folder_name ?? "",
      number: r.report_number, date: r.visit_date ?? r.uploaded_at?.slice(0, 10) ?? null, pdfName: r.pdf_name ?? `${r.file_name.replace(/\.docx?$/i, "")}.pdf`,
      why: whyGood(fx.score_parts ?? [], fx.programme?.verdict ?? null),
    });
    if ((Object.keys(EXAMPLE_KINDS) as ExampleKind[]).every((k) => out.filter((e) => e.kind === k).length >= PER_KIND)) break;
  }
  return (Object.keys(EXAMPLE_KINDS) as ExampleKind[]).flatMap((k) => out.filter((e) => e.kind === k));
}
