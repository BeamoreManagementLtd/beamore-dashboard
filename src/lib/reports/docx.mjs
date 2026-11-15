/**
 * Working inside a clerk's Word report (.docx) without Word (Ronan, 15 Nov 2026). Plain JavaScript so it can be tested
 * with node on real reports (scripts/test-report-docx.mjs).
 *  - read: the text paragraph by paragraph, the photos (pixel size, file size, stretched or not), boxes left blank
 *  - change: spelling fixes as tracked changes (the checker accepts or rejects them in Word), comments next to the
 *    paragraph an issue is about, photos made smaller (same look, far smaller file)
 *  - clean copy for the PDF: tracked changes the checker left in are accepted and comments taken out
 * Only the parts that need to change are rewritten; everything else in the file stays exactly as it was.
 */
import JSZip from "jszip";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const AUTHOR = "Beamore AI check";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const NO_FOLDERS = { createFolders: false };

/** Every innermost paragraph <w:p>…</w:p> (a paragraph inside a text box counts on its own). */
export function paragraphSpans(xml) {
  const spans = [], stack = [];
  const re = /<w:p(?=[\s>/])[^>]*?(\/?)>|<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0] === "</w:p>") {
      const open = stack.pop();
      if (open && !open.child) spans.push({ start: open.start, end: m.index + m[0].length });
      if (stack.length) stack[stack.length - 1].child = true;
    } else if (m[1] === "/") { /* empty paragraph */ } else {
      if (stack.length) stack[stack.length - 1].child = true;
      stack.push({ start: m.index, child: false });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

const textOf = (px) => unesc((px.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) ?? [])
  .map((t) => (t === "<w:tab/>" ? "\t" : t === "<w:br/>" ? "\n" : t.replace(/<[^>]+>/g, ""))).join(""));

/** Opens a report and reads what the checks need. */
export async function readReport(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml").async("string");
  const spans = paragraphSpans(xml);
  const paragraphs = spans.map((s, i) => ({ i, text: textOf(xml.slice(s.start, s.end)) }));

  // boxes left blank: a table row whose first cell is a label and whose next cell is empty, or "Label:" with nothing after
  const blanks = [];
  for (const row of xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []) {
    const cells = (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((c) => textOf(c).trim());
    for (let k = 0; k + 1 < cells.length; k += 2) {
      const label = cells[k], value = cells[k + 1];
      if (label && label.length <= 40 && /[a-z]/i.test(label) && !value && !/^(no|yes|n\/a|comments?|notes?)$/i.test(label)) blanks.push(label.replace(/:$/, ""));
    }
  }
  for (const p of paragraphs) { const m = /^([A-Z][A-Za-z /&()-]{2,30}):\s*$/.exec(p.text.trim()); if (m) blanks.push(m[1]); }
  const placeholders = paragraphs.filter((p) => /\[(insert|enter|type|add)[^\]]*\]|click or tap here to enter|\bXX\/XX\b|\bTBC\b/i.test(p.text)).map((p) => ({ i: p.i, text: p.text.slice(0, 120) }));

  // photos: the files in word/media and how big each is shown on the page
  const rels = await zip.file("word/_rels/document.xml.rels")?.async("string") ?? "";
  const relTarget = new Map([...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const shown = [];
  for (const d of xml.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g) ?? []) {
    const ext = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(d), blip = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(d);
    if (ext && blip) shown.push({ path: `word/${(relTarget.get(blip[1]) ?? "").replace(/^\.?\//, "")}`, cx: +ext[1], cy: +ext[2], cropped: /<a:srcRect\b[^>]*(l|t|r|b)="\d+"/.test(d) });
  }
  const media = Object.keys(zip.files).filter((n) => /^word\/media\/.+\.(jpe?g|png)$/i.test(n));
  return { zip, xml, spans, paragraphs, blanks: [...new Set(blanks)].slice(0, 30), placeholders: placeholders.slice(0, 20), shown, media };
}

/**
 * The ten health and safety items at the start of every report (Ronan, 15 Nov 2026: "we like to have the 10 health
 * and safety issues at the start of each report... some of the guys delete these or leave some of these empty").
 * The DfE form has its own fixed ten (the HSQW top 10); Beamore's own report has ten as in Keith Osorio's Holiday Inn
 * reports. Each item: missing (row deleted), empty, thin ("N/A", "None", "Good"...) or ok.
 */
export const HS_ITEMS = {
  dfe: [
    ["Work at height", /work(ing)?\s+(at|from)\s+heights?/i],
    ["Slips and trips", /slips?\b/i],
    ["Design hazards", /design\s+hazards?/i],
    ["Pedestrian and vehicle segregation", /pedestrian\s+(and|&)\s+vehicle|segregation/i],
    ["Housekeeping", /house\s*keeping/i],
    ["Site access and security", /site\s+access|security/i],
    ["Site fencing", /fencing|hoarding/i],
    ["Plant operations and heavy vehicles", /plant\s+operations?|heavy\s+vehicles?/i],
    ["Temporary works", /temporary\s+works?/i],
    ["Excavations", /excavations?/i],
  ],
  beamore: [
    ["Site access and security", /site\s+access|security/i],
    ["Working at height", /work(ing)?\s+(at|from)\s+heights?/i],
    ["Scaffolding", /scaffold/i],
    ["Lifting operations", /lifting/i],
    ["Slips, trips and falls", /slips?\b/i],
    ["Site hoarding / fencing", /hoarding|fencing/i],
    ["Housekeeping", /house\s*keeping/i],
    ["H&S notice boards and communication", /notice\s*boards?|communication|briefing/i],
    ["Welfare", /welfare/i],
    ["Fire plan and signage", /fire\s+(plan|points?|safety)|signage/i],
  ],
};
const THIN = /^(n\/?a|none|nil|no|ok|good|yes|tbc|-+|no change|nothing (to report|noted)( yet)?|none (noted|observed|to report)( (yet|at present|at this time))?|not (applicable|relevant)( at this stage)?)\.?$/i;

export function healthSafety(r, dfe) {
  // every table row in order, as cell texts
  const rows = (r.xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? []).map((row) => (row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((c) => textOf(c).replace(/\s+/g, " ").trim()));
  // the H&S part: from its heading row (or the start) to the People and Equipment / Quality section
  let from = rows.findIndex((c) => /^health\s*(&|and)\s*safety\b/i.test(c[0] ?? "") && !/personnel/i.test(c[0]));
  if (from < 0) from = 0;
  let to = rows.findIndex((c, k) => k > from && /^(people and equipment|quality\s*(&|and)\s*workmanship)/i.test(c[0] ?? ""));
  if (to < 0) to = rows.length;
  const part = rows.slice(from, to);
  const items = dfe ? HS_ITEMS.dfe : HS_ITEMS.beamore;
  // a row's label: a short first cell, or the form's instruction text followed by the label ("To include HSQW top 10
  // H&S issues... Work at Height")
  const isLabel = (c0 = "", re) => c0.length <= 70 ? re.test(c0) : /HSQW|add rows/i.test(c0) && re.test(c0.slice(-45));
  const labelOf = (c) => items.findIndex(([, re]) => isLabel(c[0], re));
  return items.map(([label, re], n) => {
    const k = part.findIndex((c) => isLabel(c[0], re));
    if (k < 0) return { label, status: "missing" };
    // what the clerk wrote: the rest of that row, or (Christian's layout) the rows under it before the next item
    let text = part[k].slice(1).filter((x) => !/^photo(graph)?s?\s*\d*$/i.test(x)).join(" ").trim();
    for (let j = k + 1; !text && j < part.length && labelOf(part[j]) < 0; j++) {
      const t = part[j].filter((x) => !/^photo(graph)?s?\s*\d*$|^cow (narrative|observations)/i.test(x)).join(" ").trim();
      if (t.length > 40) text = t;
    }
    // or written in the paragraphs under the heading, outside the cells (Christian Tate's layout)
    if (!text) {
      const at = r.paragraphs.findIndex((p) => p.text.replace(/\s+/g, " ").trim() === part[k][0]);
      for (let j = at + 1; at >= 0 && j < r.paragraphs.length && !text; j++) {
        const t = r.paragraphs[j].text.replace(/\s+/g, " ").trim();
        if (items.some(([, re2]) => isLabel(t, re2)) || /^(people and equipment|quality\s*(&|and)\s*workmanship)/i.test(t)) break;
        if (t.length > 40 && !/^health\s*(&|and)\s*safety$/i.test(t)) text = t;
      }
    }
    void n;
    return { label, status: !text ? "empty" : THIN.test(text) || text.length < 25 ? "thin" : "ok" };
  });
}

/**
 * The issues tracker at the end of the report (Ronan, 15 Nov 2026): a record of each issue and which report to read
 * about it in, so no photos; every item coloured red, orange or green; and an item closed out has its date, is
 * green, and says in the comments why it was closed (e.g. the right information received).
 */
const isDate = (s) => /\b\d{1,2}(st|nd|rd|th)?[\s./-]+(\d{1,2}|[a-z]{3,9})[\s./-]+\d{2,4}\b/i.test(s);
const rag = (hex) => {
  if (!hex || /^(auto|ffffff)$/i.test(hex)) return null;
  const [r, g, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
  if (g > 120 && r < 170 && b < 120) return "green";
  if (r > 200 && g >= 140 && b < 100) return "orange";
  if (r > 170 && g < 90 && b < 90) return "red";
  return null;
};
// does a closed item's comment say why it was closed? (Ronan, 15 Nov 2026: "some people just leave the comments in
// there from previously that don't actually say why the thing was closed out"). The latest part of the comment should
// say what closed it (received, completed, rectified, signed off...), not still be waiting for something.
const CLOSING = /\b(receiv|provid|suppl|submit|issued|sent|forward|email(ed)? (from|sent|receiv)|email from|letter from|note from|advised|complet|rectif|resolv|sign(ed)?[\s-]*off|confirm|install|fitted|erect|paint|placed|treat|seal|replac|remov|clos|verif|seen|observed|witness|inspect|fix|action|repair|approv|accept|agreed|done|made good|reinstat|correct|amend|changed|altered|adjust|extend|cut back|glued|protected|fire[\s-]*stopped|(engineer'?s?|sika|manufacturer'?s?|test|inspection)\s+report|test(ed)?|certif|cleared|tidied|in place|no further|satisf|sufficient|compliant|in accordance|not concerned|no concern|no issue|not (needed|required|necessary)|no \w+ (was|were|is) (needed|required))/i;
const STILL_OPEN = /\b(await|to be\b|will be|would be|ongoing|outstanding|pending|tbc|chas(e|ing)|requested|required|needs? to|not yet|yet to|still to)/i;
export function closingReasonOk(comment) {
  // at least one sentence says what closed it, without itself still waiting for something
  // ("As at 4/12/25, details were awaited" is an old progress note, not a reason for closing)
  return comment.split(/(?<=[.!?])\s*|\n|(?=\d{1,2}\/\d{1,2}\/\d{2,4})/).map((s) => s.trim())
    .some((s) => CLOSING.test(s) && !STILL_OPEN.test(s.replace(/\bno \w+ (was|were|is) (needed|required)|not (needed|required|necessary)/gi, "")));
}

export function issuesTracker(r) {
  const out = { tables: 0, items: 0, photos: 0, uncoloured: [], greenNoDate: [], closedNotGreen: [], closedNoReason: [], closedReasonUnclear: [], unclearExamples: [] };
  for (const t of r.xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    const rows = t.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
    const head = (rows[0]?.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? []).map((c) => textOf(c).replace(/\s+/g, " ").trim().toLowerCase());
    const closedCol = head.findIndex((h) => /closed/.test(h));
    if (closedCol < 0 || head.length < 3) continue;
    const commentCol = head.findIndex((h, k) => k !== closedCol && /comment|status/.test(h));
    let itemCol = head.findIndex((h) => /observation|subject|item\b/.test(h) && !/^(item|number|no\.?)$/.test(h));
    if (itemCol < 0) itemCol = head.findIndex((h, k) => k > 0 && /item/.test(h));
    out.tables++;
    out.photos += (t.match(/<w:drawing>/g) ?? []).length;
    for (const row of rows.slice(1)) {
      const cells = row.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) ?? [];
      const text = cells.map((c) => textOf(c).replace(/\s+/g, " ").trim());
      const item = text[itemCol >= 0 ? itemCol : 2] ?? "";
      if (!item) continue;
      out.items++;
      const no = text[0] || String(out.items);
      const colour = cells.map((c) => rag(/w:fill="([0-9A-Fa-f]{6}|auto)"/.exec(c)?.[1])).find(Boolean) ?? null;
      const closedText = text[closedCol] ?? "", comment = commentCol >= 0 ? text[commentCol] ?? "" : "";
      const closed = isDate(closedText) || /^closed\b/i.test(closedText);
      if (!colour) out.uncoloured.push(no);
      if (colour === "green" && !isDate(closedText) && !/^open/i.test(closedText) && !isDate(comment)) out.greenNoDate.push(no);
      if (closed && colour && colour !== "green") out.closedNotGreen.push(no);
      if (closed && comment.replace(/[^a-z]/gi, "").length < 12) out.closedNoReason.push(no);
      else if ((closed || colour === "green") && comment && !closingReasonOk(comment)) {
        out.closedReasonUnclear.push(no);
        if (out.unclearExamples.length < 3) out.unclearExamples.push({ no, comment: comment.slice(0, 120) });
      }
    }
  }
  return out;
}

/** The photo's pixel shape the way round it's shown on the page (w/h, or h/w when it's stored turned on its side). */
export const pixelShape = (pixels, shownShape) => (Math.abs(Math.log(pixels / shownShape)) <= Math.abs(Math.log(1 / pixels / shownShape)) ? pixels : 1 / pixels);

/** Photo checks: needs sharp (passed in so this file stays free of native modules). */
export async function photoStats(r, sharp) {
  const out = [];
  for (const path of r.media) {
    const buf = await r.zip.file(path).async("nodebuffer");
    let meta = {};
    try { meta = await sharp(buf).metadata(); } catch { /* unreadable image */ }
    const uses = r.shown.filter((s) => s.path === path);
    const w = meta.width ?? 0, h = meta.height ?? 0;
    // a phone photo is often stored sideways with an "upright" tag, so compare with whichever way round matches how
    // it's shown (Peter Lord's King's Maths School portraits were treated as landscape, 15 Nov 2026)
    const stretched = uses.some((u) => !u.cropped && w && h && Math.abs((u.cx / u.cy) / pixelShape(w / h, u.cx / u.cy) - 1) > 0.08);
    // what matters is detail for the size it's shown at: 150-300 dots per inch prints well
    const shownCm = Math.max(0, ...uses.map((u) => u.cx / 360000));
    const dpi = shownCm && w ? Math.round(w / (shownCm / 2.54)) : null;
    out.push({ path, bytes: buf.length, width: w, height: h, used: uses.length, stretched, shownCm: +shownCm.toFixed(1), dpi,
      blurry: dpi !== null && dpi < 150, smallOnPage: !!shownCm && shownCm < 5,
      // more detail than the page can show (or simply huge): worth making smaller
      large: (dpi !== null && dpi > 330 && buf.length > 150_000) || buf.length > 1_500_000 || Math.max(w, h) > 3000 });
  }
  const used = out.filter((p) => p.used);
  return {
    count: used.length, blurry: used.filter((p) => p.blurry).length, smallOnPage: used.filter((p) => p.smallOnPage).length,
    large: out.filter((p) => p.large).length, stretched: used.filter((p) => p.stretched).length, bytes: out.reduce((n, p) => n + p.bytes, 0), list: out,
  };
}

/** Makes photos with more detail than the page needs smaller: 300 dots per inch at the size shown (looks the same). */
export async function shrinkPhotos(r, sharp, stats) {
  let before = 0, after = 0, changed = 0;
  for (const p of stats.list.filter((x) => x.large)) {
    const buf = await r.zip.file(p.path).async("nodebuffer");
    const target = p.shownCm ? Math.max(600, Math.round((p.shownCm / 2.54) * 300)) : 1600;
    const box = p.width >= p.height ? { width: target } : { height: target };
    let img = sharp(buf, { failOn: "none" }).rotate().resize({ ...box, fit: "inside", withoutEnlargement: true });
    img = /\.png$/i.test(p.path) ? img.png({ compressionLevel: 9, palette: false }) : img.jpeg({ quality: 82, mozjpeg: true });
    const out = await img.toBuffer();
    if (out.length < buf.length * 0.9) { r.zip.file(p.path, out, NO_FOLDERS); before += buf.length; after += out.length; changed++; }
  }
  return { changed, before, after };
}

let nextId = 7_000_000;
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const isWord = (c) => /[A-Za-z0-9]/.test(c ?? "");

/** Spelling fixes as tracked changes. fixes: [{ p: paragraph number, find, replace }]. Returns how many went in. */
export function trackSpelling(r, fixes) {
  const byP = new Map();
  for (const f of fixes) if (f.find && f.replace !== undefined && f.find !== f.replace) byP.set(f.p, [...(byP.get(f.p) ?? []), f]);
  let xml = r.xml, applied = 0;
  const skipped = [];
  // work from the last paragraph back so earlier positions stay right
  for (const [pi, list] of [...byP].sort((a, b) => b[0] - a[0])) {
    const span = r.spans[pi];
    if (!span) { skipped.push(...list); continue; }
    let px = xml.slice(span.start, span.end);
    for (const f of list) {
      let done = false;
      px = px.replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g, (run) => {
        if (done) return run;
        const ts = run.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? [];
        if (ts.length !== 1 || /<w:(drawing|fldChar|instrText|tab|br|sym)\b/.test(run)) return run;
        const text = unesc(ts[0].replace(/<[^>]+>/g, ""));
        let at = -1;
        for (let k = text.indexOf(f.find); k >= 0; k = text.indexOf(f.find, k + 1)) {
          if ((!isWord(f.find[0]) || !isWord(text[k - 1])) && (!isWord(f.find.at(-1)) || !isWord(text[k + f.find.length]))) { at = k; break; }
        }
        if (at < 0) return run;
        done = true;
        const open = /^<w:r\b[^>]*>/.exec(run)[0], rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run)?.[0] ?? "";
        const piece = (t) => (t ? `${open}${rPr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>` : "");
        const d = stamp();
        return piece(text.slice(0, at))
          + `<w:del w:id="${nextId++}" w:author="${AUTHOR}" w:date="${d}">${open}${rPr}<w:delText xml:space="preserve">${esc(f.find)}</w:delText></w:r></w:del>`
          + (f.replace ? `<w:ins w:id="${nextId++}" w:author="${AUTHOR}" w:date="${d}">${open}${rPr}<w:t xml:space="preserve">${esc(f.replace)}</w:t></w:r></w:ins>` : "")
          + piece(text.slice(at + f.find.length));
      });
      if (done) applied++; else skipped.push(f);
    }
    xml = xml.slice(0, span.start) + px + xml.slice(span.end);
    // later paragraphs (already done) shift; earlier ones don't, which is why we go backwards
  }
  r.xml = xml;
  r.spans = paragraphSpans(xml);
  return { applied, skipped };
}

/** Comments in the margin, each next to its paragraph (or the first paragraph). comments: [{ p: number | null, text }] */
export async function addComments(r, comments) {
  if (!comments.length) return 0;
  const zip = r.zip;
  let cx = await zip.file("word/comments.xml")?.async("string");
  const ids = cx ? [...cx.matchAll(/<w:comment\b[^>]*w:id="(\d+)"/g)].map((m) => +m[1]) : [];
  let id = Math.max(100, ...ids) + 1;
  const d = stamp();
  const add = [];
  let xml = r.xml;
  const firstText = r.paragraphs.find((p) => p.text.trim())?.i ?? 0;
  const sorted = comments.map((c) => ({ ...c, p: Number.isInteger(c.p) && r.spans[c.p] ? c.p : firstText })).sort((a, b) => b.p - a.p);
  for (const c of sorted) {
    const span = r.spans[c.p];
    let px = xml.slice(span.start, span.end);
    const head = /^<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?/.exec(px)[0];
    px = head + `<w:commentRangeStart w:id="${id}"/>` + px.slice(head.length, -"</w:p>".length)
      + `<w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r></w:p>`;
    xml = xml.slice(0, span.start) + px + xml.slice(span.end);
    add.push(`<w:comment w:id="${id}" w:author="${AUTHOR}" w:date="${d}" w:initials="AI"><w:p><w:r><w:t xml:space="preserve">${esc(c.text)}</w:t></w:r></w:p></w:comment>`);
    id++;
  }
  r.xml = xml;
  r.spans = paragraphSpans(xml);
  if (cx) cx = cx.replace(/<\/w:comments>\s*$/, `${add.join("")}</w:comments>`);
  else {
    cx = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W}">${add.join("")}</w:comments>`;
    let rels = await zip.file("word/_rels/document.xml.rels").async("string");
    if (!/Target="comments\.xml"/.test(rels)) {
      const rid = `rId${Math.max(0, ...[...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => +m[1])) + 1}`;
      rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>`);
      zip.file("word/_rels/document.xml.rels", rels, NO_FOLDERS);
    }
    let types = await zip.file("[Content_Types].xml").async("string");
    if (!/PartName="\/word\/comments\.xml"/.test(types)) {
      types = types.replace("</Types>", `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`);
      zip.file("[Content_Types].xml", types, NO_FOLDERS);
    }
  }
  zip.file("word/comments.xml", cx, NO_FOLDERS);
  return add.length;
}

/** A small fingerprint of each photo shown (8x8 brightness pattern), to spot photos reused from earlier reports. */
export async function photoHashes(r, sharp, stats) {
  const out = [];
  for (const p of stats.list.filter((x) => x.used)) {
    try {
      const px = await sharp(await r.zip.file(p.path).async("nodebuffer"), { failOn: "none" }).rotate().resize(8, 8, { fit: "fill" }).greyscale().raw().toBuffer();
      const avg = px.reduce((a, b) => a + b, 0) / px.length;
      let bits = ""; for (const v of px) bits += v > avg ? "1" : "0";
      out.push(BigInt(`0b${bits}`).toString(16).padStart(16, "0"));
    } catch { /* unreadable */ }
  }
  return out;
}
/** How many of these fingerprints (nearly) match one from the earlier report. */
export function reusedCount(now, before) {
  if (!now?.length || !before?.length) return 0;
  const dist = (a, b) => { let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`), n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
  return now.filter((h) => before.some((b) => dist(h, b) <= 3)).length;
}

/** Photos with no words beside them (in their table cell, or their paragraph and the one after). */
export function uncaptioned(r) {
  const xml = r.xml;
  let n = 0;
  for (const m of xml.matchAll(/<w:drawing>/g)) {
    const cellStart = xml.lastIndexOf("<w:tc>", m.index), cellEnd = xml.indexOf("</w:tc>", m.index);
    const inCell = cellStart > -1 && cellEnd > m.index && cellStart > xml.lastIndexOf("</w:tc>", m.index);
    const pStart = Math.max(xml.lastIndexOf("<w:p ", m.index), xml.lastIndexOf("<w:p>", m.index));
    const pEnd = xml.indexOf("</w:p>", xml.indexOf("</w:p>", m.index) + 6);
    const around = inCell ? xml.slice(cellStart, cellEnd) : xml.slice(pStart, pEnd);
    if (textOf(around).trim().length < 8) n++;
  }
  return n;
}

/** Tick boxes nobody ticked: Word check boxes left unchecked, and ☐ characters. */
export function unticked(r) {
  return (r.xml.match(/<w14:checked w14:val="(0|false)"\/>/g) ?? []).length + r.paragraphs.reduce((n, p) => n + (p.text.match(/☐/g) ?? []).length, 0);
}

/** Puts a value in an empty box next to its label, as a tracked insertion. Only boxes that really are empty. */
export function fillBlank(r, label, value) {
  const want = label.toLowerCase().replace(/[^a-z0-9]/g, "");
  let xml = r.xml, done = false;
  xml = xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    if (done) return row;
    const cells = [...row.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)];
    for (let k = 0; k + 1 < cells.length; k++) {
      if (textOf(cells[k][0]).toLowerCase().replace(/[^a-z0-9]/g, "") !== want || textOf(cells[k + 1][0]).trim()) continue;
      const cell = cells[k + 1][0];
      const p = /<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?/.exec(cell);
      if (!p) continue;
      const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(cells[k][0])?.[0]?.replace(/<w:b\/>|<w:bCs\/>/g, "") ?? "";
      const ins = `<w:ins w:id="${nextId++}" w:author="${AUTHOR}" w:date="${stamp()}"><w:r>${rPr}<w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:ins>`;
      const at = cells[k + 1].index + p.index + p[0].length;
      done = true;
      return row.slice(0, at) + ins + row.slice(at);
    }
    return row;
  });
  // or a line that is just "Label:" with nothing after it
  if (!done) {
    const spans = paragraphSpans(xml);
    for (let i = spans.length - 1; i >= 0 && !done; i--) {
      const px = xml.slice(spans[i].start, spans[i].end);
      const t = textOf(px).trim();
      if (!t.endsWith(":") || t.slice(0, -1).toLowerCase().replace(/[^a-z0-9]/g, "") !== want) continue;
      const rPr = /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(px)?.[0]?.replace(/<w:b\/>|<w:bCs\/>/g, "") ?? "";
      const ins = `<w:ins w:id="${nextId++}" w:author="${AUTHOR}" w:date="${stamp()}"><w:r>${rPr}<w:t xml:space="preserve"> ${esc(value)}</w:t></w:r></w:ins>`;
      xml = xml.slice(0, spans[i].end - "</w:p>".length) + ins + xml.slice(spans[i].end - "</w:p>".length);
      done = true;
    }
  }
  if (done) { r.xml = xml; r.spans = paragraphSpans(xml); }
  return done;
}

/** Turns a photo the right way up (90, 180 or 270 degrees clockwise) and swaps its shown width and height if needed. */
export async function rotatePhoto(r, sharp, path, degrees) {
  const buf = await r.zip.file(path).async("nodebuffer");
  let img = sharp(buf, { failOn: "none" }).rotate().rotate(degrees);
  img = /\.png$/i.test(path) ? img.png() : img.jpeg({ quality: 85, mozjpeg: true });
  r.zip.file(path, await img.toBuffer(), NO_FOLDERS);
  if (degrees === 180) return;
  const rels = await r.zip.file("word/_rels/document.xml.rels").async("string");
  const target = path.replace(/^word\//, "");
  const ids = [...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].filter((m) => m[2].replace(/^\.?\//, "") === target).map((m) => m[1]);
  r.xml = r.xml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (d) => {
    const rid = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(d)?.[1];
    if (!rid || !ids.includes(rid)) return d;
    return d.replace(/<wp:extent cx="(\d+)" cy="(\d+)"/, '<wp:extent cx="$2" cy="$1"').replace(/<a:ext cx="(\d+)" cy="(\d+)"/, '<a:ext cx="$2" cy="$1"');
  });
  r.spans = paragraphSpans(r.xml);
}

/**
 * Puts photo shapes right: stretched or squashed photos back in proportion (same width), and photos shown under 5 cm
 * wide made 7 cm wide when they sit on their own (not in a table cell, where a bigger photo could upset the layout).
 */
export async function fixPhotoShapes(r, stats) {
  const rels = await r.zip.file("word/_rels/document.xml.rels")?.async("string") ?? "";
  const relPath = new Map([...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], `word/${m[2].replace(/^\.?\//, "")}`]));
  const byPath = new Map(stats.list.map((p) => [p.path, p]));
  let stretched = 0, enlarged = 0;
  const xml = r.xml;
  let out = "", last = 0;
  for (const m of xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)) {
    let d = m[0];
    const ph = byPath.get(relPath.get(/<a:blip\b[^>]*r:embed="([^"]+)"/.exec(d)?.[1] ?? "") ?? "");
    const ext = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(d);
    if (ph && ext && ph.width && ph.height && !/<a:srcRect\b[^>]*(l|t|r|b)="\d+"/.test(d)) {
      let cx = +ext[1], cy = +ext[2];
      const ratio = ph.height / ph.width;
      if (Math.abs((cx / cy) / (ph.width / ph.height) - 1) > 0.08) { cy = Math.round(cx * ratio); stretched++; }
      const cellAt = xml.lastIndexOf("<w:tc>", m.index), inCell = cellAt > xml.lastIndexOf("</w:tc>", m.index);
      if (cx < 1_800_000 && /<wp:inline\b/.test(d)) {
        // on its own: 7 cm wide; in a table cell: as wide as the cell allows (up to 9 cm), so the table keeps its shape
        const cellW = inCell ? +(/<w:tcW w:w="(\d+)" w:type="dxa"/.exec(xml.slice(cellAt, m.index))?.[1] ?? 0) * 635 - 250_000 : 0;
        // never bigger than the photo can print sharply (150 dots per inch)
        const sharp150 = Math.round((ph.width / 150) * 914_400);
        const target = Math.min(inCell ? Math.min(cellW, 3_240_000) : 2_520_000, sharp150);
        if (target > cx * 1.15) { cx = target; cy = Math.round(cx * ratio); enlarged++; }
      }
      if (cx !== +ext[1] || cy !== +ext[2]) {
        d = d.replace(/<wp:extent cx="\d+" cy="\d+"/, `<wp:extent cx="${cx}" cy="${cy}"`).replace(/(<pic:spPr>[\s\S]*?<a:ext )cx="\d+" cy="\d+"/, `$1cx="${cx}" cy="${cy}"`);
      }
    }
    out += xml.slice(last, m.index) + d;
    last = m.index + m[0].length;
  }
  r.xml = out + xml.slice(last);
  r.spans = paragraphSpans(r.xml);
  return { stretched, enlarged };
}

/**
 * Every photo in the report the same size (Ronan, 15 Nov 2026), like Christian Tate's reports: 6 cm, two to a line in
 * the photo panel, each keeping its orientation (landscape 6 x 4.5, portrait 4.5 x 6, square 6 x 6). Only unusual
 * shapes are trimmed from the middle with Word's own crop (undo in Word: Picture Format > Crop > Reset). Smaller if the
 * report's photo panels are narrower, still the same for every photo. Left alone: logos, signatures and icons (under 1.5 cm), plans and drawings (over 10 cm wide).
 */
export function uniformPhotos(r, stats, rels) {
  const relPath = new Map([...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], `word/${m[2].replace(/^\.?\//, "")}`]));
  const byPath = new Map(stats.list.map((p) => [p.path, p]));
  const xml = r.xml;
  const cellWidthAt = (i) => {
    const at = xml.lastIndexOf("<w:tc>", i);
    if (at < 0 || at < xml.lastIndexOf("</w:tc>", i)) return null;
    const w = /<w:tcW w:w="(\d+)" w:type="dxa"/.exec(xml.slice(at, i))?.[1];
    return w ? +w * 635 : null; // twentieths of a point -> EMU
  };
  const isPhoto = (d, ph) => {
    const ext = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(d);
    return ph && ext && +ext[1] >= 540_000 && +ext[1] <= 3_600_000 && Math.min(ph.width, ph.height) >= 200;
  };
  const drawings = [...xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)].map((m) => ({ m, ph: byPath.get(relPath.get(/<a:blip\b[^>]*r:embed="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? "") }));
  const photos = drawings.filter((x) => isPhoto(x.m[0], x.ph));
  if (photos.length < 2) return { side: null, changed: 0, wasUniform: true };
  // the size: 6 cm, unless the usual photo panel is too narrow for two of those side by side
  const widths = new Map();
  for (const x of photos) { const w = cellWidthAt(x.m.index); if (w) widths.set(w, (widths.get(w) ?? 0) + 1); }
  const panel = [...widths].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const SIX = 2_160_000, GAP = 220_000;
  let side = !panel ? SIX : panel >= 3_600_000 ? Math.min(SIX, Math.floor((panel - GAP * 2) / 2)) : Math.min(SIX, panel - GAP);
  // a few photo boxes slightly narrower: all photos come down to fit them, so they still match; one much narrower box
  // keeps its own smaller photo rather than shrinking every photo
  const tightest = Math.min(...photos.map((x) => cellWidthAt(x.m.index)).filter((w) => w).map((w) => w - GAP));
  if (Number.isFinite(tightest) && tightest < side && tightest >= side * 0.8) side = tightest;
  let out = "", last = 0, changed = 0;
  for (const x of drawings) {
    let d = x.m[0];
    if (photos.includes(x)) {
      const own = cellWidthAt(x.m.index);
      const s = Math.max(540_000, own ? Math.min(side, own - GAP) : side);
      const ext = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(d);
      const crop = /<a:srcRect\b[^>]*(l|t|r|b)="-?\d+"/.test(d);
      // keep each photo's orientation (Ronan, 15 Nov 2026): landscape photos all 4:3 and s wide, portrait all 3:4 and
      // s tall, near-square ones s square (as Christian's); only odd shapes (panoramas) trimmed to fit
      // portrait or landscape as it appears on the page (not as the pixels happen to be stored)
      const shown = crop ? +ext[1] / +ext[2] : pixelShape(x.ph.width / x.ph.height, +ext[1] / +ext[2]);
      const shape = shown >= 1.15 ? 4 / 3 : shown <= 0.87 ? 3 / 4 : 1;
      const cx = Math.round(shape > 1 ? s : shape < 1 ? s * 0.75 : s);
      const cy = Math.round(shape > 1 ? s * 0.75 : shape < 1 ? s : s);
      if (!crop && Math.abs(shown / shape - 1) > 0.03) {
        const cut = Math.round((shown > shape ? (1 - shape / shown) : (1 - shown / shape)) / 2 * 100000);
        const rect = shown > shape ? `<a:srcRect l="${cut}" r="${cut}"/>` : `<a:srcRect t="${cut}" b="${cut}"/>`;
        d = /<a:srcRect\b[^>]*\/>/.test(d) ? d.replace(/<a:srcRect\b[^>]*\/>/, rect) : d.replace(/(<a:blip\b[^>]*\/>|<a:blip\b[^>]*>[\s\S]*?<\/a:blip>)/, `$1${rect}`);
      }
      if (Math.abs(+ext[1] - cx) > 20_000 || Math.abs(+ext[2] - cy) > 20_000) {
        d = d.replace(/<wp:extent cx="\d+" cy="\d+"/, `<wp:extent cx="${cx}" cy="${cy}"`).replace(/(<pic:spPr\b[^>]*>[\s\S]*?<a:ext )cx="\d+" cy="\d+"/, `$1cx="${cx}" cy="${cy}"`);
        changed++;
      }
    }
    out += xml.slice(last, x.m.index) + d;
    last = x.m.index + x.m[0].length;
  }
  r.xml = out + xml.slice(last);
  r.spans = paragraphSpans(r.xml);
  // were they already a consistent size (each orientation within 3 mm)? Mixed sizes count against the clerk; a consistent
  // size that just isn't Christian's doesn't
  const groups = new Map();
  for (const x of photos) {
    const ext = /<wp:extent cx="(\d+)" cy="(\d+)"/.exec(x.m[0]);
    const r0 = +ext[1] / +ext[2], k = r0 >= 1.15 ? "l" : r0 <= 0.87 ? "p" : "s";
    groups.set(k, [...(groups.get(k) ?? []), +ext[1]]);
  }
  const wasUniform = [...groups.values()].every((ws) => Math.max(...ws) - Math.min(...ws) <= 108_000);
  return { side, changed, wasUniform };
}

/** The changed report as a file. */
export async function saveReport(r) {
  r.zip.file("word/document.xml", r.xml, NO_FOLDERS);
  return r.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** For the PDF: any tracked changes left are accepted, and comments taken out. The Word file itself isn't touched. */
/** Makes the dashboard's own tracked changes (spelling fixes) part of the text; anyone else's are left alone. */
export function acceptOwnRevisions(r) {
  const mine = `w:author="${esc(AUTHOR)}"`;
  r.xml = r.xml
    .replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, (m) => (m.slice(0, m.indexOf(">")).includes(mine) ? "" : m))
    .replace(/<w:ins\b([^>]*)>([\s\S]*?)<\/w:ins>/g, (m, attrs, inner) => (attrs.includes(mine) ? inner : m));
  r.spans = paragraphSpans(r.xml);
  r.paragraphs = r.spans.map((s, i) => ({ i, text: textOf(r.xml.slice(s.start, s.end)) }));
}

export async function cleanCopy(buf) {
  const zip = await JSZip.loadAsync(buf);
  for (const part of Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))) {
    let x = await zip.file(part).async("string");
    x = x.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, "")
      .replace(/<w:ins\b[^>]*>([\s\S]*?)<\/w:ins>/g, "$1")
      .replace(/<w:commentRangeStart\b[^>]*\/>|<w:commentRangeEnd\b[^>]*\/>/g, "")
      .replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, "")
      .replace(/<w:rPrChange\b[\s\S]*?<\/w:rPrChange>|<w:pPrChange\b[\s\S]*?<\/w:pPrChange>/g, "");
    zip.file(part, x, NO_FOLDERS);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
