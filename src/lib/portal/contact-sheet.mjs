/**
 * The diary's "Contact details" tab (Ronan, 15 Nov 2026): one row per person, A to K, sorted by first name.
 *  A-E are the tab's own columns (first name, last name, Beamore email, own email, phone). The tab stays the source for
 *  those: the dashboard only fills a blank, or uses what a clerk typed into the portal themselves.
 *  F-K are filled from the dashboard: company, home address, next of kin, next of kin phone, DBS and PPE. A cell is
 *  never emptied because the dashboard has nothing for it, so anything typed straight into the diary stays.
 * Rows that aren't clerks in the dashboard (Judy, Anél) are kept as they are. Clerks in the dashboard who aren't in the
 * tab are added. Plain JavaScript so it can be tested with node (scripts/test-contact-sheet.mjs).
 */
export const CONTACT_HEADERS = ["First Name [Required]", "Last Name [Required]", "Email Address [Required]", "Work Secondary Email", "Work Phone",
  "Company", "Home address", "Next of kin", "Next of kin phone", "DBS", "PPE"];
export const CONTACT_COLS = CONTACT_HEADERS.length; // A..K

const plain = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const key = (s) => plain(s).replace(/[^a-z0-9]/g, "");
const oneLine = (s) => String(s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join(", ");
const ukDate = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d ?? "");

const normK = (s) => String(s).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
const COMPANYISH = /\b(ltd|limited|llp|plc|group|associates|contracting|contractors|services|solutions|consult\w*|inspections?|surveys?|management|construction|partnership|& sons?|and sons?)\b/i;

/**
 * The company to show for a person, if they invoice through one (their own name as a sole trader doesn't count; "Ltd"
 * and "Limited" versions of the same name count once). Also used for the brackets under names in the diary.
 */
export function companyLabel(person, companies) {
  const last = normK(person.split(/\s+/).at(-1) ?? "");
  const firm = companies.filter((c) => COMPANYISH.test(c) || !normK(c).includes(last));
  const seen = new Map();
  for (const c of firm) {
    const k = normK(c.replace(/\b(ltd|limited)\b\.?/gi, ""));
    const cur = seen.get(k);
    if (!cur || (/\b(ltd|limited)\b/i.test(c) && !/\b(ltd|limited)\b/i.test(cur))) seen.set(k, c);
  }
  return seen.size ? [...seen.values()].join(" / ") : null;
}

/** F-K for one clerk from the dashboard. */
function extras(c) {
  const k = c.compliance ?? {};
  const kin = k.next_of_kin_name ? `${k.next_of_kin_name}${k.next_of_kin_relationship ? ` (${k.next_of_kin_relationship})` : ""}`
    : !k.next_of_kin_phone ? oneLine(k.emergency_contact) : "";
  const dbs = [k.dbs_level, k.dbs_checked ? `checked ${ukDate(k.dbs_checked)}` : null, k.dbs_update_service ? "update service" : null].filter(Boolean).join(", ");
  const company = companyLabel(c.name, c.companies?.length ? c.companies : k.company_name ? [k.company_name] : []) ?? "";
  return [company, oneLine(k.address), kin, oneLine(k.next_of_kin_phone), dbs, oneLine(k.ppe_notes)];
}

/**
 * existing: the tab's rows below the header, each an array of 11 strings.
 * clerks: [{ name, email, personal_email, phone, self_entered (they saved their details in the portal), companies[], compliance }]
 * Returns the rows to write, in order.
 */
export function contactRows(existing, clerks) {
  const byEmail = new Map(), byName = new Map();
  for (const c of clerks) {
    if (c.email) byEmail.set(plain(c.email), c);
    byName.set(key(c.name), c);
  }
  const used = new Set();
  const rows = [];
  for (const r0 of existing) {
    const r = Array.from({ length: CONTACT_COLS }, (_, i) => String(r0[i] ?? "").trim());
    if (!r[0] && !r[1]) continue;
    const c = (r[2] && byEmail.get(plain(r[2]))) || byName.get(key(`${r[0]} ${r[1]}`));
    if (c && !used.has(c)) {
      used.add(c);
      if (!r[2] && c.email) r[2] = c.email;
      if (c.personal_email && (!r[3] || c.self_entered)) r[3] = c.personal_email;
      if (c.phone && (!r[4] || c.self_entered)) r[4] = c.phone;
      extras(c).forEach((v, i) => { if (v) r[5 + i] = v; });
    }
    rows.push(r);
  }
  for (const c of clerks) {
    if (used.has(c)) continue;
    const [first, ...rest] = String(c.name ?? "").trim().split(/\s+/);
    if (!first || !rest.length) continue; // the tab needs a first and last name
    rows.push([first, rest.join(" "), c.email ?? "", c.personal_email ?? "", c.phone ?? "", ...extras(c)]);
  }
  return rows.sort((a, b) => plain(a[0]).localeCompare(plain(b[0])) || plain(a[1]).localeCompare(plain(b[1])));
}
