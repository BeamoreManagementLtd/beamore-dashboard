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

/** Photo checks: needs sharp (passed in so this file stays free of native modules). */
export async function photoStats(r, sharp) {
  const out = [];
  for (const path of r.media) {
    const buf = await r.zip.file(path).async("nodebuffer");
    let meta = {};
    try { meta = await sharp(buf).metadata(); } catch { /* unreadable image */ }
    const uses = r.shown.filter((s) => s.path === path);
    const w = meta.width ?? 0, h = meta.height ?? 0;
    const stretched = uses.some((u) => !u.cropped && w && h && Math.abs((u.cx / u.cy) / (w / h) - 1) > 0.08);
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

/** The changed report as a file. */
export async function saveReport(r) {
  r.zip.file("word/document.xml", r.xml, NO_FOLDERS);
  return r.zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** For the PDF: any tracked changes left are accepted, and comments taken out. The Word file itself isn't touched. */
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
