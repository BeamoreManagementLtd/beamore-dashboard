/**
 * The clerk a name written in a report belongs to (Ronan, 17 Nov 2026: "Tony Larkins and Anthony Larkins... they're the
 * same person"; "Alistair Ross Mowat" with no link). Same surname (ignoring hyphens and spaces), and the same first name
 * or a usual short form of it. Null when it isn't clear.
 */
const NICK: Record<string, string[]> = {
  anthony: ["tony", "antony", "ant"], antony: ["tony", "anthony", "ant"], tony: ["anthony", "antony"],
  andrew: ["andy", "drew"], andy: ["andrew"], stephen: ["steve", "steven"], steven: ["steve", "stephen"], steve: ["stephen", "steven"],
  christopher: ["chris"], chris: ["christopher", "christian"], robert: ["rob", "bob", "robbie"], rob: ["robert"],
  michael: ["mike", "mick"], mike: ["michael"], william: ["will", "bill"], peter: ["pete"], pete: ["peter"],
  david: ["dave"], dave: ["david"], nicholas: ["nick"], nick: ["nicholas"], richard: ["rich", "rick"], james: ["jim", "jamie"],
  daniel: ["dan", "danny"], matthew: ["matt"], jonathan: ["jon", "john"], john: ["jon", "jonathan"], thomas: ["tom"], tom: ["thomas"],
  edward: ["ed", "eddie"], joseph: ["joe"], benjamin: ["ben"], ben: ["benjamin"], alistair: ["ali", "alastair", "alasdair"], alastair: ["alistair"],
};
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
const parts = (s: string) => { const w = norm(s).split(" ").filter(Boolean); return { first: w[0] ?? "", last: w.slice(1).join("") }; };

export function clerkForName<T extends { id: string; name: string }>(written: string | null | undefined, clerks: T[]): T | null {
  if (!written || !written.trim()) return null;
  const a = parts(written);
  if (!a.first || !a.last) return null;
  const same = clerks.filter((c) => { const b = parts(c.name); return b.last === a.last || b.last.endsWith(a.last) || a.last.endsWith(b.last); });
  const hit = same.filter((c) => { const f = parts(c.name).first; return f === a.first || (NICK[a.first] ?? []).includes(f) || (NICK[f] ?? []).includes(a.first) || f.startsWith(a.first) || a.first.startsWith(f); });
  return hit.length === 1 ? hit[0] : same.length === 1 && hit.length === 0 ? null : null;
}
