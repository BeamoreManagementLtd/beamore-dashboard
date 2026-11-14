/**
 * Matching key for a site as typed in the diary or a Xero reference:
 * "StAidans(M&E)", "St Aidans", "St. Aidans - Building" all become "staidans".
 * Shared by the sync jobs and one-off scripts, so it is plain JavaScript.
 */
export function siteKey(s) {
  return String(s ?? "")
    .replace(/\((m&e|building|bldg|fabric)\)|m&e|\bbuilding\b/gi, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}
