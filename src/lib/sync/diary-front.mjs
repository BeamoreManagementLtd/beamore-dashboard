/**
 * Reads the front page of a CoW diary (.docx): "DfE Project Director: Victoria Carruthers" and so on, the value on the
 * same line or the next one. Returns only the fields found, trimmed.
 */
import JSZip from "jszip";

export const FRONT_FIELDS = {
  dfe_project_number: /^DfE Project Number/i,
  dfe_project_director: /^DfE Project Director/i,
  dfe_project_manager: /^DfE Project Manager/i,
  ta_firm: /^Technical Advis[eo]r Firm/i,
  ta_name: /^Technical Advis[eo]r Name/i,
  principal_contractor: /^Principal Contractor\s*:/i,
  pc_project_number: /^Principal Contractor Project Number/i,
  pc_project_manager: /^Principal Contractor Project Manager/i,
  site_address: /^Site Address/i,
  project_name: /^Project Name/i,
};

export async function readDiaryFront(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xml = (await zip.file("word/document.xml")?.async("string")) ?? "";
  const lines = xml.split(/<\/w:p>/).map((p) => p.replace(/<w:tab\/>/g, " ").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 60);
  const out = {};
  lines.forEach((line, i) => {
    for (const [key, re] of Object.entries(FRONT_FIELDS)) {
      if (out[key] || !re.test(line) || !line.includes(":")) continue;
      let value = line.slice(line.indexOf(":") + 1).trim();
      // value on the next line when the label stands alone (and the next line isn't another label)
      if (!value && lines[i + 1] && !/:\s*$/.test(lines[i + 1]) && !Object.values(FRONT_FIELDS).some((r) => r.test(lines[i + 1]))) value = lines[i + 1];
      if (value && value.length < 150) out[key] = value;
    }
  });
  return out;
}
