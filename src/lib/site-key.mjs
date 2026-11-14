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

const NICK = { andy: "andrew", rob: "robert", bob: "robert", steve: "stephen", dave: "david", mike: "michael", chris: "christopher", tony: "anthony", tom: "thomas", jim: "james", pete: "peter" };

/**
 * One key per clerk however the diary spells them: "Andy Marris" = "Andrew Marris", "Adrian Carrol" = "Adrian Carroll",
 * "Tom Hunt\n(Inspect South West Limited)" = "Tom Hunt".
 */
export function clerkKey(name) {
  const words = String(name ?? "").split("\n")[0].toLowerCase().replace(/[^a-z\s-]/g, "").trim().split(/\s+/);
  if (!words[0]) return "";
  words[0] = NICK[words[0]] ?? words[0];
  return words.map((w) => w.replace(/(.)\1+/g, "$1")).join(" ");
}
export const clerkDisplay = (name) => String(name ?? "").split("\n")[0].trim().replace(/\s+/g, " ");
