import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * The AI read of one report (Ronan, 15 Nov 2026): spelling fixes to put in as tracked changes, and the issues a
 * checker should look at before it goes out. Claude Sonnet: careful enough for this, and far cheaper than Opus at
 * 60-70 reports a day.
 */
export const REPORT_MODEL = "claude-sonnet-5-5";

export type Issue = { severity: "high" | "medium" | "low"; kind: string; text: string; p: number | null };
export type Check = {
  summary: string; visit_date: string | null; report_number: string | null; clerk_name: string | null;
  spelling: { p: number; find: string; replace: string }[]; issues: Issue[];
  rotate: { photo: number; degrees: 90 | 180 | 270 }[]; clerk_points: string[];
  programme: Programme;
};
/**
 * How the report's progress reporting measures up (Ronan, 15 Nov 2026). DfE reports (TAS2025 / TAS21 forms): the
 * "Progress vs programme" box done his way. Other clients' reports: a clear progress summary like Damian Breen's
 * (The Forum) and Keith Osorio's (Holiday Inn Camden).
 */
export type Programme = {
  dfe: boolean;
  verdict: "good" | "weak" | "missing" | "not_in_form";
  items: number; programme_named: boolean; per_item_weeks: boolean; critical_path: boolean; narrative: boolean; overall_weeks: boolean;
  percentages_shown: boolean; looks_from_site_team: boolean; p: number | null; note: string;
};

const str = { type: "string" }, nstr = { type: ["string", "null"] };
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "visit_date", "report_number", "clerk_name", "spelling", "issues", "rotate", "clerk_points", "programme"],
  properties: {
    summary: { type: "string", description: "One or two plain sentences for the checker: is it fit to send, and the main thing to look at" },
    visit_date: { ...nstr, description: "Visit date this report covers, YYYY-MM-DD (the last one if several)" },
    report_number: { ...nstr, description: "The report/diary number as written, e.g. 34 or R17" },
    clerk_name: { ...nstr, description: "The clerk of works named in the report" },
    spelling: {
      type: "array", description: "Spelling, grammar and punctuation corrections (applied automatically)",
      items: { type: "object", additionalProperties: false, required: ["p", "find", "replace"], properties: {
        p: { type: "integer", description: "Paragraph number it's in" }, find: { ...str, description: "The wrong text exactly as written (a word or short phrase)" }, replace: str } },
    },
    issues: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["severity", "kind", "text", "p"], properties: {
        severity: { type: "string", enum: ["high", "medium", "low"] },
        kind: { type: "string", enum: ["dates", "names", "numbering", "blank", "copied", "follow-up", "vague", "safety", "photos", "programme", "other"] },
        text: { ...str, description: "Short and specific, written for the checker" },
        p: { type: ["integer", "null"], description: "Paragraph number it's about, if any" } } },
    },
    rotate: {
      type: "array", description: "Attached photos that are on their side or upside down",
      items: { type: "object", additionalProperties: false, required: ["photo", "degrees"], properties: { photo: { type: "integer", description: "Photo number as labelled" }, degrees: { type: "integer", enum: [90, 180, 270], description: "Clockwise turn to make it upright" } } },
    },
    clerk_points: { type: "array", items: str, description: "Up to 5 short, friendly, specific points for the clerk to do better next time (not spelling)" },
    programme: {
      type: "object", additionalProperties: false, description: "Progress reporting judged against Beamore's standard (DfE: the progress vs programme method; others: the progress summary)",
      required: ["dfe", "verdict", "items", "programme_named", "per_item_weeks", "critical_path", "narrative", "overall_weeks", "percentages_shown", "looks_from_site_team", "p", "note"],
      properties: {
        dfe: { type: "boolean", description: "This is a DfE report (DfE Site Visit Diary / Site Visit Report / CQM Monthly Report form, TAS2025 or TAS21)" },
        verdict: { type: "string", enum: ["good", "weak", "missing", "not_in_form"], description: "DfE: good = follows the method; weak = there but short of it; missing = the box is empty, N/A or a few lines. Not DfE: judge the progress summary the same way. not_in_form = genuinely nothing of the kind expected in this report" },
        items: { type: "integer", description: "How many programme activities are listed with their own ahead/behind/on-programme position" },
        programme_named: { type: "boolean", description: "It says which programme it's measured against (title, revision or date)" },
        per_item_weeks: { type: "boolean", description: "Each listed activity says how many weeks ahead or behind (or on programme)" },
        critical_path: { type: "boolean", description: "Critical-path activities are among those listed or named" },
        narrative: { type: "boolean", description: "There is a written synopsis of at least 5-6 lines weighing up the items ahead and behind, the causes, and where the clerk thinks the project is" },
        overall_weeks: { type: "boolean", description: "It ends with an estimate of how many weeks behind or ahead the contractor is overall" },
        percentages_shown: { type: "boolean", description: "Percentage completions are written in the section (clients asked for these to be left out)" },
        looks_from_site_team: { type: "boolean", description: "It reads as the contractor's own figures repeated, not the clerk's independent assessment" },
        p: { type: ["integer", "null"], description: "Paragraph number where the section starts" },
        note: { ...str, description: "One sentence for the checker on what's missing or good about it" },
      },
    },
  },
};

/**
 * What a good Beamore report looks like, from the reports Ronan holds up as the standard (Christian Tate, Margaret
 * Jeffers-Carter, Steve Cassidy, Nick Jenkin, Keith Osorio; Nov 2026).
 */
const STANDARD = `What good looks like at Beamore (from the best clerks' reports):
- Every heading has specific observations: where (building, level, area, gridline), what was seen, who (which contractor or trade), and the control or action in place. e.g. "Heras panels and pedestrian barriers defined the route beside the cabins and separated it from the borehole and delivery areas."
- Even "nothing to report" is specific: "Corridors and stairs clear. No trailing leads, ramps in use for level changes." Not just "N/A" or "OK".
- Issues found say what needs doing and by whom, and urgent safety issues are flagged for the client straight away.
- A weekly site diary is typically 1,800-5,000 words with 35-50 photos covering the areas described.
- Visit date(s) stated, report numbered in sequence, CoW name filled in, standard boxes completed.
- DfE reports (TAS2025 / TAS21 forms): "Progress vs programme (and the causes of any delays)" is done the Beamore way (Ronan's instruction to all clerks, agreed with Mott MacDonald and the DfE):
  * say which programme it's measured against (title, revision, date);
  * 8-10 activities from that programme, preferably on the critical path;
  * for each, the clerk's own independent view of where it is (not the site team's figures, which are often exaggerated), stated in weeks, e.g. "Installation of staircases – 3 weeks behind", "Ground beams – 2 weeks behind", "Entrance road base course – 3 weeks ahead", "Brickwork – on programme in section 2, 4 weeks behind in section 3";
  * the weeks are worked out from planned v actual progress (e.g. windows 25 weeks long, programme says 80%, actually 60%: 20% of 25 weeks = 5 weeks behind), but percentages are NOT written in the report (the client asked for them to be left out), and there's no separate tracker table;
  * then at least 5-6 lines of synopsis: weighing up all the items, how far behind or ahead each is and why, and where the clerk thinks the project is overall, e.g. "I estimate that the contractor is 3.5 weeks behind programme."
- Other clients' reports (not DfE): no fixed progress box, but a good report opens with a clear progress summary, like Damian Breen's (The Forum) and Keith Osorio's (Holiday Inn Camden): progress area by area, level by level and trade by trade; what's complete and what's outstanding; the completion target and whether the clerk thinks it's realistic. If the report has a programme section, the DfE method above is still the best way to fill it.
  * Fair exceptions: if the clerk explains there is no agreed programme to measure against (and still describes progress, the risks and what's needed), or the works have reached practical completion, don't mark it down for missing weeks.`;

export type CheckInput = {
  fileName: string; folder: string; project: string; projectNumbers: string[]; client: string | null;
  expectedClerks: string[]; diaryVisits: string[]; previous: { number: string | null; date: string | null; text: string } | null;
  paragraphs: { i: number; text: string }[]; blanks: string[]; placeholders: { i: number; text: string }[];
  photos: { count: number; blurry: number; smallOnPage: number; stretched: number; mb: number; usual: number | null; reused: number; uncaptioned: number };
  unticked: number; thumbnails: Buffer[]; today: string;
};

export async function checkReport(input: CheckInput): Promise<Check> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic();
  // the report text, paragraph by paragraph (long reports are cut to keep it affordable)
  let body = "", n = 0;
  for (const p of input.paragraphs) {
    if (!p.text.trim()) continue;
    const line = `[${p.i}] ${p.text.replace(/\s+/g, " ").trim()}\n`;
    if (n + line.length > 60_000) { body += "[…the rest of the report is not shown…]\n"; break; }
    body += line; n += line.length;
  }
  const facts = [
    `Today: ${input.today}`, `File name: ${input.fileName}`, `Folder: ${input.folder}`,
    `Project: ${input.project}${input.client ? ` (client ${input.client})` : ""}`,
    input.projectNumbers.length ? `Project numbers on record: ${input.projectNumbers.join(", ")}` : "",
    input.expectedClerks.length ? `Clerk(s) on this job: ${input.expectedClerks.join(", ")}` : "",
    input.diaryVisits.length ? `Visits in Beamore's diary for this job in the last 3 weeks: ${input.diaryVisits.join("; ")}` : "",
    input.previous ? `Previous report: number ${input.previous.number ?? "?"}, visit ${input.previous.date ?? "?"}` : "No previous report on record",
    `Photos: ${input.photos.count}${input.photos.usual ? ` (this clerk's last reports on this job had about ${input.photos.usual})` : ""}; ${input.photos.blurry} too low detail to print well, ${input.photos.smallOnPage} shown under 5 cm wide, ${input.photos.stretched} stretched out of shape, ${input.photos.reused} the same as photos in the previous report, ${input.photos.uncaptioned} with no words beside them; file ${input.photos.mb.toFixed(1)} MB`,
    input.unticked ? `Tick boxes left unticked: ${input.unticked}` : "",
    input.blanks.length ? `Labels with an empty box next to them (many are optional checklist lines; only raise ones that matter): ${input.blanks.join("; ")}` : "",
    input.placeholders.length ? `Placeholder text: ${input.placeholders.map((p) => `[${p.i}] ${p.text}`).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  const ask = `You are checking a clerk of works site report for Beamore Management Ltd before it is sent to the client. UK English.

${STANDARD}

1. Spelling, grammar and punctuation (these are put right automatically, so be thorough but safe): spelling mistakes, typos, doubled words, US spellings (e.g. "color"), plain grammar errors (e.g. "the works was", "it's" for "its", a missing word), a missing capital at the start of a sentence, double spaces, a space before a full stop or comma. Keep each fix to a word or short phrase. Never change technical terms, product names, codes, people's or company names, abbreviations, or the clerk's style. "find" must be copied exactly from that paragraph.
2. Issues for the person checking it, most important first, and only real ones:
 - dates: visit date doesn't match the file name, the heading, the diary, or a weekday doesn't match its date; a date in the future
 - names: wrong project, school or client name; a different clerk than expected
 - numbering: report number not following on from the previous one
 - blank: important boxes left empty (visit date, CoW name, date issued, weather/attendance if the form asks) or placeholder text left in
 - copied: whole sections that look copied unchanged from the previous report
 - follow-up: problems raised in the previous report not mentioned again
 - vague: observations with nothing specific (no location, no detail, no action)
 - safety: health and safety concerns that may need escalating to the client straight away (high)
 - photos: from the photo figures given: far fewer than usual (medium), reused from the previous report (medium), too low detail to print well; missing captions is only low. Stretched, sideways, oversized and small-on-the-page photos are put right automatically: don't raise those
 - programme: DfE report whose progress vs programme box falls short of the method above (missing or a few lines = high; weak = medium; percentages written in = low). For other clients, a missing or thin progress summary = medium
 - other: unticked tick boxes, layout problems
 Severity: high = must be fixed or looked at before it goes; medium = should be fixed; low = minor.
Give the paragraph number when an issue is about one place. Don't repeat spelling fixes as issues.
3. rotate: attached photos (labelled Photo 1, 2...) that are on their side or upside down.
4. clerk_points: what this clerk could do better next time, judged against the standard above: specific, friendly, no more than 5, not about spelling.
5. programme: say whether it's a DfE report, then judge its progress reporting against the right standard above. For DfE be strict, item by item: no programme named, fewer than 8 activities, activities with no weeks, percentages instead of weeks, or a synopsis under 5-6 lines with no overall view, is "weak".`;
  const content: Anthropic.ContentBlockParam[] = [
    { type: "text", text: `${facts}\n\n${input.previous ? `PREVIOUS REPORT (for comparison, start of it):\n${input.previous.text.slice(0, 8000)}\n\n` : ""}THIS REPORT:\n${body}` },
    ...input.thumbnails.slice(0, 12).flatMap((b, k) => [
      { type: "text" as const, text: `Photo ${k + 1}:` },
      { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: b.toString("base64") } },
    ]),
    { type: "text", text: `${ask}${input.thumbnails.length ? "\nSome of the report's photos are attached, small: mention any that are badly blurred or very dark, and list any on their side or upside down in rotate." : ""}` },
  ];
  const res = await client.messages.create({
    model: REPORT_MODEL, max_tokens: 6000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  if (res.stop_reason === "refusal") throw new Error("The AI declined to check this report");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("The AI returned no answer");
  return JSON.parse(text.text) as Check;
}
