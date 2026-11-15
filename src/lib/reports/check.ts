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
};

const str = { type: "string" }, nstr = { type: ["string", "null"] };
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "visit_date", "report_number", "clerk_name", "spelling", "issues", "rotate", "clerk_points"],
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
        kind: { type: "string", enum: ["dates", "names", "numbering", "blank", "copied", "follow-up", "vague", "safety", "photos", "other"] },
        text: { ...str, description: "Short and specific, written for the checker" },
        p: { type: ["integer", "null"], description: "Paragraph number it's about, if any" } } },
    },
    rotate: {
      type: "array", description: "Attached photos that are on their side or upside down",
      items: { type: "object", additionalProperties: false, required: ["photo", "degrees"], properties: { photo: { type: "integer", description: "Photo number as labelled" }, degrees: { type: "integer", enum: [90, 180, 270], description: "Clockwise turn to make it upright" } } },
    },
    clerk_points: { type: "array", items: str, description: "Up to 5 short, friendly, specific points for the clerk to do better next time (not spelling)" },
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
- Visit date(s) stated, report numbered in sequence, CoW name filled in, standard boxes completed.`;

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
 - other: unticked tick boxes, layout problems
 Severity: high = must be fixed or looked at before it goes; medium = should be fixed; low = minor.
Give the paragraph number when an issue is about one place. Don't repeat spelling fixes as issues.
3. rotate: attached photos (labelled Photo 1, 2...) that are on their side or upside down.
4. clerk_points: what this clerk could do better next time, judged against the standard above: specific, friendly, no more than 5, not about spelling.`;
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
