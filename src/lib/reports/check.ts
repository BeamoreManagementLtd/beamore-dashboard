import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { STANDARDS, STANDARD_KEYS, type StandardsMet } from "./standards";

/**
 * The AI read of one report (Ronan, 15 Nov 2026): spelling fixes to put in as tracked changes, and the issues a
 * checker should look at before it goes out. Claude Sonnet: careful enough for this, and far cheaper than Opus at
 * 60-70 reports a day.
 */
export const REPORT_MODEL = "claude-sonnet-5-5";

/** near: a few words from where it is in the report; page: the page Word puts that on (filled in by the office PC) */
export type Issue = { severity: "high" | "medium" | "low"; kind: string; text: string; p: number | null; near?: string | null; page?: number | null };
export type Check = {
  summary: string; visit_date: string | null; report_number: string | null; clerk_name: string | null;
  /** how the visit date is written in the report itself (not its file name) — Ronan wants each visit's date */
  date_on_report?: "visit_dates" | "week_commencing" | "month_only" | "none";
  spelling: { p: number; find: string; replace: string }[]; issues: Issue[];
  rotate: { photo: number; degrees: 90 | 180 | 270 }[]; clerk_points: string[];
  /** the AI's overall judgement of the report out of 100 (Ronan, 15 Nov 2026: "take an overall look at the report") */
  quality: number; quality_why?: string;
  programme: Programme;
  /** which of the team's best practices (standards.ts) this report meets */
  standards: StandardsMet;
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
  type: "object", additionalProperties: false, required: ["summary", "visit_date", "date_on_report", "report_number", "clerk_name", "spelling", "issues", "rotate", "clerk_points", "quality", "quality_why", "programme", "standards"],
  properties: {
    summary: { type: "string", description: "One or two plain sentences for the checker: is it fit to send, and the main thing to look at" },
    visit_date: { ...nstr, description: "Visit date this report covers, YYYY-MM-DD (the last one if several)" },
    date_on_report: { type: "string", enum: ["visit_dates", "week_commencing", "month_only", "none"], description: "How the visit date is written in the report's own text (ignore the file name): visit_dates = the actual date of each visit is written; week_commencing = only a week (\"w/c 09/11/26\", \"week commencing\", \"week ending\") rather than the day(s) visited; month_only = a monthly report giving only the month; none = no visit date written in the report at all" },
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
    clerk_points: { type: "array", items: str, description: "Up to 5 short, friendly, specific points for the clerk to do better next time (not spelling, never naming other people)" },
    quality: { type: "integer", description: "Quality of the information out of 100 (see 4c)" },
    quality_why: { type: "string", description: "One friendly sentence: why the information lost marks and how to improve it (empty if 100). Never name other people" },
    standards: {
      type: "object", additionalProperties: false, required: STANDARD_KEYS, description: "Whether this report meets each of the team's best practices (true = clearly does)",
      properties: Object.fromEntries(STANDARD_KEYS.map((k) => [k, { type: "boolean", description: STANDARDS[k].test }])),
    },
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
- Every heading has specific observations: where (e.g. the level and room, corridor or area, or a gridline), what was seen, who (which contractor or trade), and the control or action in place. e.g. "Heras panels and pedestrian barriers defined the route beside the cabins and separated it from the borehole and delivery areas."
- A LOCATION is precise enough when it names the level and the room, corridor or area (e.g. "1st floor south corridor", "2nd floor science classroom NE"). Gridlines are only one way of saying where: never ask for gridlines, and never say an observation lacks a location, when it already gives the level and room/area. Only raise location where an observation really gives no way of finding the work (Ronan, 26 Nov 2026, after Peter Bertans was asked for gridlines on a Wisbech report that gave them, and Peter Lord on reports naming the floor and room for every item).
- Even "nothing to report" is specific: "Corridors and stairs clear. No trailing leads, ramps in use for level changes." Not just "N/A" or "OK". (The ten standard health and safety items are the exception: "N/A" is fine there when nothing of that kind is happening, e.g. no excavations, and is never a fault.)
- TRADES AND NUMBERS: a photo or screenshot of the site's sign-in system (Biosite or similar) showing the trades and numbers on site records them properly. Never say trades or numbers are blank or missing when one is there ([picture] near the trades / people box), and never ask for them to be typed out as well. The main contractor's management team should still be named: the DfE has asked for this (Ronan, 26 Nov 2026, after Mark Hanson's Polam Hall R34).
- READ THE WHOLE REPORT before saying something is missing: never say an issues-tracker item has no description, comment or closure note when that item is described elsewhere in the report (the observation it came from, or the text beside its photo). Only raise a tracker item as unclear when the report gives no explanation of it anywhere (Ronan, 26 Nov 2026, same report). The tracker itself should be text only, with no photos: Beamore doesn't want photos on the issues tracker.
- Issues found say what needs doing and by whom, and urgent safety issues are flagged for the client straight away.
- A weekly site diary is typically 1,800-5,000 words with 35-50 photos covering the areas described.
- Visit date(s) stated, report numbered in sequence, CoW name filled in, standard boxes completed.
- Ronan wants every clerk doing all of the best bits of the team's reports:
${STANDARD_KEYS.map((k) => { const s = STANDARDS[k] as { label: string; test: string; from: string; dfe?: string }; return `  * ${s.label}: ${s.test} (best seen in ${s.from})${s.dfe ? `. On the DfE form: ${s.dfe}` : ""}`; }).join("\n")}
- THE FORMAT:
  * DfE reports (DfE Site Visit Diary, DfE Site Visit Report, CQM Monthly Report; TAS2025 / TAS21) are on the DfE's own standard form, which Beamore must use and cannot change. Many checklist boxes will be empty or not apply at the stage of works; that is fine and is not an issue. Never suggest adding sections, tables or a different layout to a DfE report. Judge each best practice within the form's own boxes as described above; where the form has no place for one, count it as met.
  * Other clients' reports are Beamore's own format and can be changed: they should include everything the best reports have. A missing section (no progress summary, no issues tracker, no weather/people, no items under review) is an issue to raise.
- DfE reports (TAS2025 / TAS21 forms): "Progress vs programme (and the causes of any delays)" is done the Beamore way (Ronan's instruction to all clerks, agreed with Mott MacDonald and the DfE):
  * say which programme it's measured against (title, revision, date);
  * 8-10 activities from that programme, preferably on the critical path;
  * for each, the clerk's own independent view of where it is (not the site team's figures, which are often exaggerated), stated in weeks, e.g. "Installation of staircases – 3 weeks behind", "Ground beams – 2 weeks behind", "Entrance road base course – 3 weeks ahead", "Brickwork – on programme in section 2, 4 weeks behind in section 3";
  * the weeks are worked out from planned v actual progress (e.g. windows 25 weeks long, programme says 80%, actually 60%: 20% of 25 weeks = 5 weeks behind); percentages may be shown as well, but the weeks are what matter;
  * then at least 5-6 lines of synopsis: weighing up all the items, how far behind or ahead each is and why, and where the clerk thinks the project is overall, e.g. "I estimate that the contractor is 3.5 weeks behind programme."
- Other clients' reports (not DfE): no fixed progress box, but a good report opens with a clear progress summary, like Damian Breen's (The Forum) and Keith Osorio's (Holiday Inn Camden): progress area by area, level by level and trade by trade; what's complete and what's outstanding; the completion target and whether the clerk thinks it's realistic. If the report has a programme section, the DfE method above is still the best way to fill it.
- Weekly CQM reports (the DfE CQM Lead / MEP / Discipline Specialist Site Inspection Reports, i.e. the CQM forms other than the CQM Monthly Report) don't have to comment on progress vs programme: that is done in the CQM Monthly Report. On a weekly CQM report with little or no progress comment, programme.verdict is "not_in_form", and it is never an issue or a clerk point (Ronan, 19 Nov 2026).
  * Fair exceptions: if the clerk explains there is no agreed programme to measure against (and still describes progress, the risks and what's needed), or the works have reached practical completion, don't mark it down for missing weeks.`;

export type CheckInput = {
  fileName: string; folder: string; project: string; projectNumbers: string[]; client: string | null;
  /** The job has no project number or code at all (Ronan, 24 Nov 2026: Pepys Court): TBC or blank there is right. */
  noProjectNumber?: boolean;
  /** A small job needs fewer photos (Ronan, 26 Nov 2026: "Ewell is a small project so probably only 20 photos needed"). */
  photoTarget?: number | null;
  /** Quality and technical matters only, no H&S or progress (Ronan, 26 Nov 2026: Mark Taylor's M&E reports for The Forum). */
  qualityOnly?: boolean;
  expectedClerks: string[]; diaryVisits: string[]; previous: { number: string | null; date: string | null; text: string } | null;
  paragraphs: { i: number; text: string; pic?: boolean }[]; blanks: string[]; placeholders: { i: number; text: string }[];
  photos: { count: number; blurry: number; smallOnPage: number; stretched: number; mb: number; usual: number | null; reused: number; uncaptioned: number };
  unticked: number; thumbnails: Buffer[]; today: string;
  /**
   * Earlier checks of this same report, newest first, when the clerk runs it through "Check before uploading" again
   * after fixing things (Alan Wilcox, 20 Nov 2026: "each time I fixed what it asked for it came back with something
   * new... it feels like it's marking it fresh each time rather than against a set list").
   */
  earlierChecks?: { quality: number | null; why: string | null; points: string[] }[];
  /** The report's appendix, a separate PDF the clerk keeps observations in (Tom Hunt's St Michael's field-note reports). */
  appendix?: { name: string; pdf: Buffer } | null;
};

export async function checkReport(input: CheckInput): Promise<Check> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic();
  // the report text, paragraph by paragraph (long reports are cut to keep it affordable)
  let body = "", n = 0;
  for (const p of input.paragraphs) {
    // a picture is shown as [picture], so a weather app screenshot in the weather box reads as filled in (Ronan, 19 Nov 2026)
    if (!p.text.trim() && !p.pic) continue;
    const line = `[${p.i}] ${`${p.text.replace(/\s+/g, " ").trim()}${p.pic ? " [picture]" : ""}`.trim()}\n`;
    if (n + line.length > 60_000) { body += "[…the rest of the report is not shown…]\n"; break; }
    body += line; n += line.length;
  }
  const facts = [
    `Today: ${input.today}`, `File name: ${input.fileName}`, `Folder: ${input.folder}`,
    `Project: ${input.project}${input.client ? ` (client ${input.client})` : ""}`,
    input.projectNumbers.length ? `Project numbers on record: ${input.projectNumbers.join(", ")}` : "",
    input.noProjectNumber ? "This job has no project number or project code: \"TBC\", \"N/A\" or a blank in the project number / code box is correct, so never raise it or count it against the report" : "",
    input.qualityOnly ? "This report covers quality and technical matters only: it has no health and safety section and no progress / programme section, and isn't meant to. Never raise, suggest or count against it anything about health and safety or progress" : "",
    input.photoTarget ? `This is a small job: about ${input.photoTarget} photos is enough for a report here (not the usual 35-50), so never raise the number of photos when there are ${input.photoTarget} or more` : "",
    input.expectedClerks.length ? `Clerk(s) on this job: ${input.expectedClerks.join(", ")}` : "",
    input.previous ? `Previous report: number ${input.previous.number ?? "?"}, visit ${input.previous.date ?? "?"}` : "No previous report on record",
    `Photos: ${input.photos.count}${input.photos.usual ? ` (this clerk's last reports on this job had about ${input.photos.usual})` : ""}; ${input.photos.blurry} too low detail to print well, ${input.photos.smallOnPage} shown under 5 cm wide, ${input.photos.stretched} stretched out of shape, ${input.photos.reused} the same as photos in the previous report; file ${input.photos.mb.toFixed(1)} MB. These are the report's real photo figures; the photos attached below are only a sample of up to 12, so never describe that sample as the number of photos`,
    input.unticked ? `Tick boxes left unticked: ${input.unticked}` : "",
    input.blanks.length ? `Labels with an empty box next to them (many are optional checklist lines; only raise ones that matter): ${input.blanks.join("; ")}` : "",
    input.placeholders.length ? `Placeholder text: ${input.placeholders.map((p) => `[${p.i}] ${p.text}`).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
  const ask = `You are checking a clerk of works site report for Beamore Management Ltd before it is sent to the client. UK English.

${STANDARD}

1. Spelling, grammar and punctuation (these are put right automatically, so be thorough but safe): spelling mistakes, typos, doubled words, US spellings (e.g. "color"), plain grammar errors (e.g. "the works was", "it's" for "its", a missing word), a missing capital at the start of a sentence, double spaces, a space before a full stop or comma. Keep each fix to a word or short phrase. Never change technical terms, product names, codes, people's or company names, abbreviations, or the clerk's style. "find" must be copied exactly from that paragraph.
2. Issues for the person checking it, most important first, and only real ones:
 - dates: visit date doesn't match the file name or the heading, or a weekday doesn't match its date; a date in the future (never compare with Beamore's diary: its dates are only estimates for costing). Something the clerk did after the visit, dated when they did it (an email sent, information asked for, a follow-up booked), is not a date slip: never raise it (Alan Wilcox, 20 Nov 2026)
 - names: wrong project, school or client name; a different clerk than expected
 - numbering: report number not following on from the previous one
 - blank: important boxes left empty (visit date, CoW name, weather/attendance if the form asks) or placeholder text left in. [picture] marks a picture in the report: a picture in the weather box (a screenshot of the forecast from a weather app or website) records the weather properly, so the weather is NOT blank, missing or vague and is never a fault. On a DfE form, empty checklist boxes that don't apply at this stage are NOT an issue. Never raise "Date issued to Lead Consultant (TA)" being empty: the office fills that in when it sends the report
 - layout (use kind "other", medium): for non-DfE reports only, a section the best reports have that this one is missing
 - copied: whole sections that look copied unchanged from the previous report
 - follow-up: problems raised in the previous report not mentioned again. An earlier item the report says wasn't looked at on this visit, with when it will be, IS mentioned: that's honest reporting, better than writing about something not seen, so never raise it and never take marks off for it, here or in the quality score (Alan Wilcox, 20 Nov 2026)
 - vague: observations with nothing specific (no location, no detail, no action)
 - (the ten standard health and safety items at the start are checked separately: don't raise deleted or empty H&S rows)
 - safety: health and safety concerns that may need escalating to the client straight away (high)
 - photos: from the photo figures given: far fewer than usual (medium), reused from the previous report (medium), too low detail to print well. Photos don't have captions: the description of what's going on is written in the column beside them and the photos back it up, so never raise missing captions. Stretched, oversized and small-on-the-page photos are put right automatically: don't raise those
 - programme: DfE report whose progress vs programme box falls short of the method above (missing or a few lines = high; weak = medium). For other clients, a missing or thin progress summary = medium
 - other: unticked tick boxes, layout problems
 Severity: high = must be fixed or looked at before it goes; medium = should be fixed; low = minor.
When an issue is about one place, put that paragraph's number in "p". Never write paragraph numbers in any wording (issues, summary, clerk points, notes): the [n] markers are only for you, the reader sees pages and has never heard of them, so "p193" or "paragraphs 31/32" means nothing to them. Refer to other places by quoting a few of their words or naming the section or box, e.g. the "Existing Sports hall, work completed..." entry appears twice in the Services boxes. Don't repeat spelling fixes as issues.
3. rotate: attached photos (labelled Photo 1, 2...) that are on their side or upside down.
4. clerk_points: what this clerk could do better next time, judged against the standard above: specific, no more than 5. They go in an email from the office to an experienced professional, so word them as friendly, encouraging suggestions that steer ("it would help to...", "worth adding..."), never orders, criticism or "you must"; never mention other clerks, other people or anyone else's reports; not about spelling, and not repeating the best practices or the progress section (those are added separately).
4c. quality: your score out of 100 for the QUALITY OF THE INFORMATION in the report as the clerk wrote it, the way an experienced director would judge it: how complete, specific and useful the observations are (where, what, who, what's in place), accuracy and consistency, follow-up of earlier items, and whether it's clear what the clerk saw for themselves. Spelling, photos, the health and safety items, the progress section, the best practices, the issues tracker and the file name are all marked separately, so leave them out of this score. Don't simply count issues: a thorough, useful report with some slips is still a good report. Start from 100 (a perfect report) and come down only for what's actually wrong (Ronan, 16 Nov 2026: "if it's a perfect score, it's 100 out of 100; if there's a little bit wrong, it's a 92 out of 100"): 100 nothing wrong; 90-99 a little wrong (a few minor slips); 80-89 some things to put right; 70-79 several gaps or one important one; 50-69 a lot missing or wrong; below 50 poor or largely empty.
4b. standards: for each of the team's best practices, whether this report clearly meets it (for a DfE report, within the form's own boxes; true where the form has no place for it). Monthly reports can summarise the weekly diaries, so judge "people" and "follow_up" against what a monthly report would hold. For "people", a picture in the weather box (a weather app or website screenshot) counts as recording the weather.
5. programme: say whether it's a DfE report, then judge its progress reporting against the right standard above. For DfE be strict, item by item: no programme named, fewer than 8 activities, activities with no weeks ahead/behind, or a synopsis under 5-6 lines with no overall view, is "weak". Set percentages_shown but it isn't a fault.`;
  const content: Anthropic.ContentBlockParam[] = [
    ...(input.earlierChecks?.length ? [{ type: "text" as const, text: `EARLIER CHECKS OF THIS SAME REPORT (the clerk has been fixing it and is checking it again; newest first):\n${input.earlierChecks.map((c, k) => `Check ${k + 1}: information scored ${c.quality ?? "?"}/100${c.why ? ` (${c.why})` : ""}${c.points.length ? `. Points raised: ${c.points.join(" | ")}` : ""}`).join("\n")}\n\nMark against the same yardstick as those checks, so the clerk can tell when the report is done: for each point raised before, judge whether it's now dealt with. Don't raise new points about parts those checks were happy with unless that part has changed for the worse, and don't move the goalposts with fresh minor suggestions: a new point only if it's a real problem that should have been raised before. Don't score the information lower than the last check unless something has got worse.` }] : []),
    { type: "text", text: `${facts}\n\n${input.previous ? `PREVIOUS REPORT (for comparison, start of it):\n${input.previous.text.slice(0, 8000)}\n\n` : ""}THIS REPORT:\n${body}` },
    // read together with its appendix (Ronan, 17 Nov 2026: Tom Hunt keeps his H&S and quality comments there)
    ...(input.appendix ? [
      { type: "text" as const, text: `THIS REPORT'S APPENDIX ("${input.appendix.name}"), attached below. It is part of the report: the clerk keeps observations here (e.g. health and safety, quality and workmanship). Read the report and the appendix together. Anything covered in the appendix is NOT missing from the report, a "see appendix" reference is fine, and judge detail, follow-up and quality across both.` },
      { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: input.appendix.pdf.toString("base64") } },
    ] : []),
    ...input.thumbnails.slice(0, 12).flatMap((b, k) => [
      { type: "text" as const, text: `Photo ${k + 1}:` },
      { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: b.toString("base64") } },
    ]),
    { type: "text", text: `${ask}${input.thumbnails.length ? "\nA sample of the report's photos is attached, small: mention any that are badly blurred or very dark, and list in rotate only photos that are clearly and certainly on their side or upside down (people, buildings or text sideways). If unsure, leave it out." : ""}` },
  ];
  const res = await client.messages.create({
    model: REPORT_MODEL, max_tokens: 6000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  if (res.stop_reason === "refusal") throw new Error("The AI declined to check this report");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("The AI returned no answer");
  return withoutParagraphNumbers(JSON.parse(text.text) as Check, input.paragraphs);
}

/**
 * The check reads the report as numbered paragraphs ([n], one per Word paragraph and table cell, so a 30-page report
 * runs to hundreds), and sometimes still writes those numbers into its wording ("p193", "paragraphs 31/32"), which
 * mean nothing to the reader (Ronan, 18 Nov 2026, East Coast College report 15). Any that slip through become a few
 * quoted words from that paragraph. Only a lower-case "p" counts, and no leading zero: "P05" is the report's own code.
 */
export function withoutParagraphNumbers(c: Check, paragraphs: { i: number; text: string }[]): Check {
  const words = (i: number) => {
    for (let k = i; k < Math.min(paragraphs.length, i + 4); k++) {
      const t = (paragraphs[k]?.text ?? "").split(/[\t\n]/).map((x) => x.trim()).find((x) => /[A-Za-z]{3}/.test(x));
      if (t) { const w = t.split(/\s+/); return `"${w.slice(0, 6).join(" ")}${w.length > 6 ? "..." : ""}"`; }
    }
    return null;
  };
  const fix = (t: string) => t
    .replace(/\s*\((?:p|[Pp]ara(?:graph)?s?)\.?\s?([1-9]\d{0,3})\)/g, (_m, n) => { const w = words(+n); return w ? ` (${w})` : ""; })
    // "paragraphs 166 and 169", "paras 31/32", "paragraphs 172-181": every number in the run is swapped
    .replace(/\b(?:p|[Pp]ara(?:graph)?s?)\.?\s?([1-9]\d{0,3})((?:\s*(?:,|\/|-|–|and|&|to)\s*[1-9]\d{0,3}\b)*)\b/g, (_m, n, rest: string) => {
      const ns = [+n, ...(rest.match(/\d+/g) ?? []).map(Number)];
      const ws = ns.map(words).filter((w): w is string => !!w);
      if (!ws.length) return "another part of the report";
      return /^\s*(-|–|to)/.test(rest) && ws.length === 2 ? ws[0] + " to " + ws[1] : ws.length > 1 ? ws.slice(0, -1).join(", ") + " and " + ws[ws.length - 1] : ws[0];
    });
  return {
    ...c, summary: fix(c.summary), quality_why: c.quality_why ? fix(c.quality_why) : c.quality_why,
    issues: c.issues.map((i) => ({ ...i, text: fix(i.text) })), clerk_points: c.clerk_points.map(fix),
    programme: { ...c.programme, note: fix(c.programme.note) },
  };
}
