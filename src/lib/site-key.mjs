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

const NICK = { andy: "andrew", rob: "robert", bob: "robert", steve: "stephen", dave: "david", mike: "michael", chris: "christopher", tony: "anthony", antony: "anthony", tom: "thomas", jim: "james", pete: "peter" };

/**
 * One key per clerk however the diary spells them: "Andy Marris" = "Andrew Marris", "Adrian Carrol" = "Adrian Carroll",
 * "Tom Hunt\n(Inspect South West Limited)" = "Tom Hunt".
 */
export function clerkKey(name) {
  // first person only ("Andy Kay & Damian Breen"), no middle initials ("Christian M. Tate", "Peter A Restorick")
  const first = String(name ?? "").split("\n")[0].split(/\s*(?:&|\band\b|,)\s*/i)[0];
  const words = first.toLowerCase().replace(/[^a-z\s-]/g, " ").trim().split(/\s+/).filter((w, i, a) => i === 0 || i === a.length - 1 || w.length > 1);
  if (!words[0]) return "";
  words[0] = NICK[words[0]] ?? words[0];
  return words.map((w) => w.replace(/(.)\1+/g, "$1")).join(" ");
}
export const clerkDisplay = (name) => String(name ?? "").split("\n")[0].trim().replace(/\s+/g, " ");
