import { siteKey } from "@/lib/site-key.mjs";

type P = { id: string; name: string; diary_aliases: string[] };

/**
 * Finds the project an invoice reference or line description is about:
 * exact name/diary spelling first, then a shortened name that points to only one project ("Dukes Wharf"),
 * then (for free text) the longest project name found inside it.
 */
export function projectMatcher(projects: P[]) {
  const byKey = new Map<string, string>();
  for (const p of projects) for (const a of [p.name, ...p.diary_aliases]) if (siteKey(a)) byKey.set(siteKey(a), p.id);
  const keys = [...byKey.keys()];

  const fromReference = (ref?: string | null) => {
    if (!ref) return null;
    const head = siteKey(ref.split(/\s+[-–]\s+/)[0]);
    const exact = byKey.get(head) ?? byKey.get(siteKey(ref));
    if (exact) return exact;
    if (head.length < 5) return null;
    const hits = new Set(keys.filter((k) => k.length >= 5 && (k.startsWith(head) || head.startsWith(k))).map((k) => byKey.get(k)));
    return hits.size === 1 ? [...hits][0]! : null;
  };
  const fromText = (text?: string | null) => {
    if (!text) return null;
    const t = siteKey(text);
    const found = keys.filter((k) => k.length >= 6 && t.includes(k)).sort((a, b) => b.length - a.length);
    if (!found.length) return null;
    const best = new Set(found.filter((k) => k.length === found[0].length).map((k) => byKey.get(k)));
    return best.size === 1 ? [...best][0]! : null;
  };
  return { fromReference, fromText, byKey };
}
