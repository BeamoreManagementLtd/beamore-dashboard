/**
 * Pure helpers for patching single cells inside an .xlsx sheet's XML without touching anything else.
 * Plain JavaScript so they can be tested with node (scripts/test-diary-cells.mjs).
 */
const escXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Replaces the contents of one existing cell with plain text, keeping its style. */
export function setCell(xml, ref, text) {
  const re = new RegExp(String.raw`<((?:\w+:)?)c\b([^>]*?)\br="${ref}"([^>]*?)(\/>|>[\s\S]*?<\/\1c>)`, "g");
  const m = [...xml.matchAll(re)];
  if (m.length !== 1) throw new Error(`cell ${ref} isn't in the sheet as expected`);
  const [whole, pre, a, b] = m[0];
  const attrs = `${a} r="${ref}"${b}`.replace(/\s+t="[^"]*"/, "").replace(/\s*\/$/, "");
  const fresh = `<${pre}c${attrs.startsWith(" ") ? "" : " "}${attrs} t="inlineStr"><${pre}is><${pre}t xml:space="preserve">${escXml(text)}</${pre}t></${pre}is></${pre}c>`;
  return xml.slice(0, m[0].index) + fresh + xml.slice(m[0].index + whole.length);
}

/** The opening tag and style index of one cell. */
export function cellStyle(xml, ref) {
  const m = new RegExp(String.raw`<(?:\w+:)?c\b[^>]*\br="${ref}"[^>]*>`).exec(xml);
  if (!m) return null;
  return { tag: m[0], s: /\bs="(\d+)"/.exec(m[0])?.[1] ?? "0" };
}

/** The style index identical to `from` except for the diary's existing light-green fill (FF92D050), if any. */
export function greenVersion(styles, from) {
  const fillsXml = /<(?:\w+:)?fills\b[^>]*>([\s\S]*?)<\/(?:\w+:)?fills>/.exec(styles)?.[1] ?? "";
  const fills = [...fillsXml.matchAll(/<(?:\w+:)?fill>[\s\S]*?<\/(?:\w+:)?fill>|<(?:\w+:)?fill\/>/g)].map((m) => m[0]);
  const green = new Set(fills.map((f, i) => (/patternType="solid"/.test(f) && /fgColor[^>]*rgb="FF92D050"/i.test(f) ? i : -1)).filter((i) => i >= 0));
  const xfsXml = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(styles)?.[1] ?? "";
  const xfs = [...xfsXml.matchAll(/<(?:\w+:)?xf\b[^>]*\/>|<(?:\w+:)?xf\b[^>]*>[\s\S]*?<\/(?:\w+:)?xf>/g)].map((m) => m[0]);
  const base = xfs[from];
  if (!base || !green.size) return null;
  const strip = (x) => x.replace(/\s+fillId="\d+"/, "").replace(/\s+applyFill="[^"]*"/, "");
  const idx = xfs.findIndex((x, i) => i !== from && green.has(Number(/fillId="(\d+)"/.exec(x)?.[1] ?? -1)) && strip(x) === strip(base));
  return idx >= 0 ? idx : null;
}
