// Tries the report toolkit on a local copy of a clerk's report: node scripts/test-report-docx.mjs <report.docx> <out.docx>
// Reads it, shrinks photos, adds two tracked spelling changes and a comment, then checks the result is valid Word XML
// and that the clean (PDF) copy has no tracked changes or comments left.
import fs from "node:fs";
import sharp from "sharp";
import JSZip from "jszip";
import { SaxesParser } from "saxes";
import { readReport, photoStats, shrinkPhotos, trackSpelling, addComments, saveReport, cleanCopy } from "../src/lib/reports/docx.mjs";

const [src, dst] = process.argv.slice(2);
const r = await readReport(fs.readFileSync(src));
const words = r.paragraphs.filter((p) => p.text.trim());
console.log(`${r.paragraphs.length} paragraphs (${words.length} with text), ${r.media.length} images, ${r.shown.length} shown`);
console.log("first lines:", words.slice(0, 6).map((p) => `[${p.i}] ${p.text.slice(0, 70)}`).join(" | "));
console.log("blank boxes:", r.blanks.join(", ") || "none", "| placeholders:", r.placeholders.length);
const stats = await photoStats(r, sharp);
console.log(`photos: ${stats.count} shown, ${stats.large} to shrink, ${stats.blurry} blurry, ${stats.smallOnPage} small on the page, ${stats.stretched} stretched, ${(stats.bytes / 1e6).toFixed(1)} MB`);
const shrunk = await shrinkPhotos(r, sharp, stats);
console.log(`shrunk ${shrunk.changed} photos: ${(shrunk.before / 1e6).toFixed(1)} MB -> ${(shrunk.after / 1e6).toFixed(1)} MB`);

// a pretend spelling fix: swap the first word of 4+ letters in two paragraphs for a marked version, and back is easy to see
const targets = words.filter((p) => /\b[A-Za-z]{5,}\b/.test(p.text)).slice(2, 4);
const fixes = targets.map((p) => { const w = /\b([A-Za-z]{5,})\b/.exec(p.text)[1]; return { p: p.i, find: w, replace: `${w}[TEST]` }; });
const t = trackSpelling(r, fixes);
console.log("tracked changes:", t.applied, "of", fixes.length, fixes.map((f) => `${f.find}`).join(", "), "| skipped:", t.skipped.length);
console.log("comments:", await addComments(r, [{ p: targets[0]?.i ?? null, text: "TEST comment from the report check" }, { p: null, text: "TEST general comment" }]));
const out = await saveReport(r);
fs.writeFileSync(dst, out);
console.log(`saved ${(fs.statSync(src).size / 1e6).toFixed(1)} MB -> ${(out.length / 1e6).toFixed(1)} MB`);

const wellFormed = async (buf, part) => { const x = await (await JSZip.loadAsync(buf)).file(part)?.async("string"); if (!x) return "missing"; try { const p = new SaxesParser(); p.write(x).close(); return "ok"; } catch (e) { return `BROKEN: ${e.message.slice(0, 120)}`; } };
for (const part of ["word/document.xml", "word/comments.xml", "word/_rels/document.xml.rels", "[Content_Types].xml"]) console.log(part, await wellFormed(out, part));
const clean = await cleanCopy(out);
const cx = await (await JSZip.loadAsync(clean)).file("word/document.xml").async("string");
console.log("clean copy:", await wellFormed(clean, "word/document.xml"), "| tracked left:", (cx.match(/<w:(ins|del)\b/g) ?? []).length, "| comment marks left:", (cx.match(/commentRange|commentReference/g) ?? []).length, "| [TEST] words kept (accepted):", (cx.match(/\[TEST\]/g) ?? []).length);
