/**
 * Opens an .xlsx with ExcelJS, first tidying files that some tools write in a way ExcelJS can't read:
 * a byte-order mark at the start of the XML parts, absolute part paths ("/xl/workbook.xml") in the relationship
 * files, and an "x:" prefix on every element (the Report Turnaround workbook is saved like this).
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";

export async function loadWorkbook(data) {
  const zip = await JSZip.loadAsync(data);
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(xml|rels)$/i.test(name)) continue;
    let xml = await zip.file(name).async("string");
    const before = xml;
    xml = xml.replace(/^﻿/, "");
    // <x:worksheet xmlns:x="…spreadsheetml/2006/main"> → <worksheet xmlns="…">
    const pre = /xmlns:(\w+)="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/.exec(xml)?.[1];
    if (pre) xml = xml.replace(new RegExp(`<(/?)${pre}:`, "g"), "<$1").replace(`xmlns:${pre}=`, "xmlns=");
    if (name.endsWith(".rels")) {
      // "_rels/.rels" → base ""; "xl/_rels/workbook.xml.rels" → base "xl/"
      const base = name.replace(/_rels\/[^/]+$/, "");
      xml = xml.replace(/Target="\/([^"]+)"/g, (_, abs) => `Target="${abs.startsWith(base) ? abs.slice(base.length) : "../".repeat(base.split("/").filter(Boolean).length) + abs}"`);
    }
    // only cell values are needed: drop Excel tables, charts and drawings, which ExcelJS can trip over
    if (name.endsWith(".rels")) xml = xml.replace(/<Relationship\b[^>]*Type="[^"]*\/(table|drawing|chart)"[^>]*\/>/g, "");
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name))
      xml = xml.replace(/<tableParts\b[\s\S]*?<\/tableParts>|<tableParts\b[^>]*\/>|<drawing\b[^>]*\/>/g, "")
        // ISO date cells (t="d") are misread by ExcelJS as tiny serial numbers: keep them as text ("2026-07-23T00:00:00")
        .replace(/(<c\b[^>]*\bt=)"d"/g, '$1"str"');
    if (xml !== before) zip.file(name, xml);
  }
  for (const name of Object.keys(zip.files)) if (/^xl\/(tables|drawings|charts)\//.test(name)) zip.remove(name);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await zip.generateAsync({ type: "nodebuffer" }));
  return wb;
}
