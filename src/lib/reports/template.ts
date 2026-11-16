import JSZip from "jszip";

/**
 * Did the clerk start this report from last week's checked report? (Ronan, 16 Nov 2026: the office changes the layout,
 * and the next week the clerks have changed it back, or written in bold or colour.)
 *
 *  1. Word's editing IDs (rsids in word/settings.xml): a document started from last week's checked report carries all
 *     of that report's IDs. Missing ones mean it was started from an older copy or a different file. A strong hint, not
 *     proof, and nothing to go on when a file was saved by something other than Word.
 *  2. The fixed parts (headings, table header rows, bold labels, header and footer): what the office changed in last
 *     week's report (its version as the clerk sent it, against the version that went out) should still be there.
 *  3. Formatting: bold, coloured, highlighted or underlined text, and fonts, that last week's report didn't have.
 * Shown on the report's page and as a gentle point for the clerk; it doesn't change the score.
 */

type Fmt = "bold" | "colour" | "highlight" | "underline";
export type TemplateBits = {
  rsids: Set<string>;
  headings: string[]; // styled headings, table header rows, header and footer: steady from week to week
  labels: string[]; // short paragraphs that are all bold (labels), used only against what the office changed
  fmt: Record<Fmt, { paras: number; examples: string[] }>;
  colours: Map<string, number>;
  fonts: Map<string, number>;
};
export type TemplateCheck = {
  against: { id: string; number: string | null; name: string };
  started: "yes" | "older" | "no" | "unknown";
  missingSessions: number;
  undone: string[]; // the office's changes that didn't carry over
  layout: string[]; // differences in the fixed parts, when we can't tell what the office changed
  formatting: string[];
};

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const textOf = (xml: string) => decode([...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")).replace(/\s+/g, " ").trim();
/** Two versions of the same fixed text are the same if they differ only in numbers, dates, case or spacing. */
const norm = (s: string) => s.toLowerCase().replace(/\d+/g, "#").replace(/[:.\s]+$/g, "").replace(/\s+/g, " ").trim();
const on = (rpr: string, tag: string) => { const m = new RegExp(`<w:${tag}(?:\\s+w:val="([^"]*)")?\\s*/>`).exec(rpr); return !!m && !/^(0|false|off|none)$/i.test(m[1] ?? ""); };

function colourName(hex: string) {
  const n = parseInt(hex, 16); if (Number.isNaN(n)) return "coloured";
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255, max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 40) return max < 90 ? "black" : "grey";
  if (r === max && g < r * 0.6 && b < r * 0.6) return "red";
  if (r === max && g >= r * 0.6 && b < r * 0.5) return g > r * 0.85 ? "yellow" : "orange";
  if (g === max) return "green";
  if (b === max) return r > b * 0.6 ? "purple" : "blue";
  return "coloured";
}

export async function templateBits(buf: Buffer | ArrayBuffer): Promise<TemplateBits> {
  const zip = await JSZip.loadAsync(buf);
  const settings = await zip.file("word/settings.xml")?.async("string") ?? "";
  const rsids = new Set([...settings.matchAll(/<w:rsid(?:Root)?\s+w:val="([0-9A-Fa-f]+)"/g)].map((m) => m[1].toUpperCase()));
  const xml = await zip.file("word/document.xml")?.async("string") ?? "";
  const styles = await zip.file("word/styles.xml")?.async("string") ?? "";
  // style ids that are headings or titles (by id or by name)
  const headingStyles = new Set([...styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)]
    .filter((m) => /heading|title/i.test(m[1]) || /<w:name w:val="(heading|title|subtitle)/i.test(m[2])).map((m) => m[1]));

  const headings: string[] = [], labels: string[] = [];
  const fmt: TemplateBits["fmt"] = { bold: { paras: 0, examples: [] }, colour: { paras: 0, examples: [] }, highlight: { paras: 0, examples: [] }, underline: { paras: 0, examples: [] } };
  const colours = new Map<string, number>(), fonts = new Map<string, number>();
  for (const t of xml.match(/<w:tbl>[\s\S]*?<\/w:tr>/g) ?? []) {
    const row = /<w:tr\b[\s\S]*$/.exec(t)?.[0] ?? "";
    const cells = (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map(textOf).filter(Boolean);
    if (cells.length >= 2 && cells.every((c) => c.length <= 60)) headings.push(`Table: ${cells.join(" | ")}`);
  }
  for (const p of xml.match(/<w:p\b(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g) ?? []) {
    const text = textOf(p);
    if (!text) continue;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1];
    if (style && headingStyles.has(style) && text.length <= 120) { headings.push(text); continue; }
    const runs = [...p.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)].map((m) => ({ rpr: /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(m[1])?.[1] ?? "", text: textOf(m[1]) })).filter((r) => r.text.trim());
    if (!runs.length) continue;
    if (text.length <= 80 && runs.every((r) => on(r.rpr, "b"))) { labels.push(text); continue; }
    const seen = new Set<Fmt>();
    for (const r of runs) {
      const colour = /<w:color w:val="([0-9A-Fa-f]{6})"/.exec(r.rpr)?.[1];
      const kinds: [Fmt, boolean][] = [
        ["bold", on(r.rpr, "b")],
        ["colour", !!colour && !["black", "grey"].includes(colourName(colour))],
        ["highlight", /<w:highlight w:val="(?!none)/.test(r.rpr) || /<w:shd\b[^>]*w:fill="(?!auto|FFFFFF)[0-9A-Fa-f]{6}"/.test(r.rpr)],
        ["underline", /<w:u w:val="(?!none)/.test(r.rpr)],
      ];
      for (const [k, yes] of kinds) {
        if (!yes || r.text.trim().length < 3) continue;
        if (!seen.has(k)) { seen.add(k); fmt[k].paras++; if (fmt[k].examples.length < 3) fmt[k].examples.push(r.text.trim().slice(0, 50)); }
        if (k === "colour") colours.set(colourName(colour!), (colours.get(colourName(colour!)) ?? 0) + 1);
      }
      const font = /<w:rFonts\b[^>]*w:ascii="([^"]+)"/.exec(r.rpr)?.[1];
      if (font) fonts.set(font, (fonts.get(font) ?? 0) + 1);
    }
  }
  for (const f of Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) {
    const t = textOf(await zip.file(f)!.async("string"));
    if (t && t.length <= 200) headings.push(`${f.includes("header") ? "Header" : "Footer"}: ${t}`);
  }
  return { rsids, headings: [...new Set(headings)], labels: [...new Set(labels)], fmt, colours, fonts };
}

const list = (a: string[], n = 4) => `${a.slice(0, n).map((x) => `"${x.slice(0, 70)}"`).join(", ")}${a.length > n ? ` and ${a.length - n} more` : ""}`;

/**
 * now: the new report; last: last week's report as it went out; lastAsSent: last week's report as the clerk sent it
 * (if kept); beforeLast: the report before that. Word drops the IDs of text that's been deleted, so a few of last
 * week's IDs going missing is normal; what counts is whether the newest ones (the office's own edits in Word, and the
 * clerk's work on last week's report) came across.
 */
export function compareTemplate(now: TemplateBits, last: TemplateBits, lastAsSent: TemplateBits | null, beforeLast: TemplateBits | null, against: TemplateCheck["against"]): TemplateCheck {
  // 1. editing IDs
  let started: TemplateCheck["started"] = "unknown", missingSessions = 0;
  const inNow = (ids: string[]) => ids.filter((x) => now.rsids.has(x)).length;
  // last week's file saved by something other than Word (it then has next to no IDs): nothing to go on
  if (now.rsids.size >= 3 && last.rsids.size >= 3 && last.rsids.size >= now.rsids.size * 0.2) {
    const office = lastAsSent && lastAsSent.rsids.size >= 3 ? [...last.rsids].filter((x) => !lastAsSent.rsids.has(x)) : [];
    const newest = beforeLast && beforeLast.rsids.size >= 3 ? [...last.rsids].filter((x) => !beforeLast.rsids.has(x)) : [];
    const shared = inNow([...last.rsids]) / last.rsids.size;
    if (office.length && !inNow(office)) { started = "older"; missingSessions = office.length; }
    else if (newest.length >= 3) started = inNow(newest) / newest.length >= 0.1 ? "yes" : shared >= 0.5 ? "older" : "no";
    else started = shared >= 0.9 ? "yes" : shared < 0.3 ? "no" : "unknown";
  }

  // 2. fixed parts
  const has = (bits: TemplateBits, s: string) => [...bits.headings, ...bits.labels].some((x) => norm(x) === norm(s));
  const undone: string[] = [], layout: string[] = [];
  if (lastAsSent) {
    const all = (b: TemplateBits) => [...b.headings, ...b.labels];
    const added = all(last).filter((x) => !has(lastAsSent, x)); // the office put these in
    const removed = all(lastAsSent).filter((x) => !has(last, x)); // the office took these out or changed them
    const lostAdded = added.filter((x) => !has(now, x)), backRemoved = removed.filter((x) => has(now, x));
    for (const b of backRemoved) {
      const pair = lostAdded.find((a) => a.split(":")[0] === b.split(":")[0] || a.toLowerCase().slice(0, 4) === b.toLowerCase().slice(0, 4));
      if (pair) { undone.push(`"${b.slice(0, 70)}" is back where the office changed it to "${pair.slice(0, 70)}"`); lostAdded.splice(lostAdded.indexOf(pair), 1); }
      else undone.push(`"${b.slice(0, 70)}" is back (the office took it out)`);
    }
    for (const a of lostAdded) undone.push(`"${a.slice(0, 70)}" (put in by the office) is missing`);
  } else {
    // without the clerk's own version of last week's report, only the steady parts (styled headings, header, footer)
    const steady = (b: TemplateBits) => b.headings.filter((x) => !x.startsWith("Table:"));
    const gone = steady(last).filter((x) => !has(now, x)), extra = steady(now).filter((x) => !has(last, x));
    if (gone.length) layout.push(`in last week's report but not this one: ${list(gone)}`);
    if (extra.length) layout.push(`new in this one: ${list(extra)}`);
  }

  // 3. formatting and fonts the last report didn't have
  const formatting: string[] = [];
  const word: Record<Fmt, string> = { bold: "bold", colour: "coloured", highlight: "highlighted", underline: "underlined" };
  for (const k of Object.keys(word) as Fmt[]) {
    const n = now.fmt[k].paras, before = last.fmt[k].paras;
    if (n >= 2 && n > before * 2 + 1) {
      const colours = k === "colour" ? [...now.colours.keys()].filter((c) => !last.colours.has(c)) : [];
      formatting.push(`${colours.length ? `${colours.join(" and ")} text` : `${word[k]} text`} in ${n} paragraph${n === 1 ? "" : "s"} (${before ? `${before} last week` : "none last week"}), e.g. ${list(now.fmt[k].examples, 2)}`);
    }
  }
  const lastFonts = [...last.fonts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const newFonts = [...now.fonts.entries()].filter(([f, n]) => n >= 3 && !last.fonts.has(f)).map(([f]) => f);
  if (newFonts.length) formatting.push(`a different font: ${newFonts.join(", ")}${lastFonts[0] ? ` (last week's report used ${lastFonts[0]})` : ""}`);

  return { against, started, missingSessions, undone: undone.slice(0, 10), layout, formatting };
}

/** The points for the checker, worded for the "What the check found" list. */
export function templateIssues(t: TemplateCheck) {
  const ref = t.against.number ? `report ${t.against.number}` : "last week's report";
  const out: { severity: "medium" | "low"; text: string }[] = [];
  if (t.started === "no") out.push({ severity: "medium", text: `Template: this doesn't look like it was started from ${ref} as it went out, so changes the office made to it may have been lost` });
  if (t.started === "older") out.push({ severity: "medium", text: `Template: this looks like it was started from an older copy of ${ref}${t.missingSessions ? ", without the office's edits to it in Word" : ", not the one that went out"}` });
  if (t.undone.length) out.push({ severity: "medium", text: `Template: the office's changes to ${ref} didn't carry over: ${t.undone.join("; ")}` });
  if (t.layout.length) out.push({ severity: "low", text: `Template: the layout differs from ${ref}: ${t.layout.join("; ")}` });
  if (t.formatting.length) out.push({ severity: "low", text: `Formatting not in ${ref}: ${t.formatting.join("; ")}` });
  return out;
}

/** A friendly point for the clerk (Ronan, 15 Nov 2026: suggestions, not orders). */
export function templatePoint(t: TemplateCheck) {
  const lost = t.started === "no" || t.started === "older" || t.undone.length > 0;
  if (lost && t.formatting.length) return "It'd really help to start each report from last week's report in the project folder (the office sometimes tidies the layout), and to keep the text in the report's normal style rather than adding bold or colour";
  if (lost) return "It'd really help to start each report from last week's report in the project folder, as the office sometimes tidies the layout and it's a shame to lose those changes";
  if (t.formatting.length) return "Keeping the text in the report's normal style (no extra bold, colour or different fonts) keeps the reports looking consistent for the client";
  return null;
}

const words = (s: string) => new Set(s.toLowerCase().replace(/\.docx?$/, "").match(/[a-z&]{3,}/g) ?? []);
const monthlyish = (s: string) => /monthly/i.test(s);
/**
 * Which earlier report to compare with: the most recent one of the same series (weekly with weekly, monthly with
 * monthly, a similar file name) and an earlier number. None if nothing matches, so nothing gets compared wrongly.
 */
export function pickLast<T extends { file_name: string; folder_name?: string | null; report_number: string | null }>(rep: T, earlier: T[]): T[] {
  const num = (x: T) => { const m = /\d+/.exec(x.report_number ?? ""); return m ? Number(m[0]) : null; };
  const me = words(rep.file_name), myNum = num(rep), mine = monthlyish(`${rep.file_name} ${rep.folder_name ?? ""}`);
  return earlier.filter((e) => {
    if (monthlyish(`${e.file_name} ${e.folder_name ?? ""}`) !== mine) return false;
    const n = num(e); if (myNum !== null && n !== null && n >= myNum) return false;
    const w = words(e.file_name), shared = [...me].filter((x) => w.has(x)).length;
    return shared / Math.max(1, Math.min(me.size, w.size)) >= 0.5;
  });
}
