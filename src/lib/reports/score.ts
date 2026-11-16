/**
 * A report's mark out of 100 (Ronan, 16 Nov 2026): judged on the report as the clerk sent it, before any corrections,
 * on everything agreed matters. A perfect report is 100 (10 out of 10); each slip costs marks in its own part.
 *   Quality of the information 40 · Photos 10 · Spelling and grammar 10 · Health and safety items 10 ·
 *   Progress vs programme / summary 10 · Best practices 10 · Issues tracker and file name 10
 */
export type ScorePart = { label: string; got: number; of: number; note: string };

type In = {
  /** the AI's judgement of the information: detail, accuracy, follow-up, seen v told (0-100) */
  quality: number | null;
  /** expected: what a good report has (0 = not judged on numbers, e.g. a monthly report) */
  photos: { count: number; expected: number; mixed: boolean; stretched: number; small: number; blurry: number; sideways: number; reused: number };
  /** spelling and grammar mistakes the check found, and the report's length in words */
  spelling: number; words: number;
  /** the ten H&S items (null: not judged, e.g. the first reports on a job or the CQM monthly report) */
  hs: { label: string; status: string }[] | null;
  programme: { dfe: boolean; verdict: string } | null; programmeGaps: number;
  standards: Record<string, boolean> | null;
  /** tracker: kinds of problem found (photos in it, not coloured, closed without date/green/reason); null = no tracker */
  tracker: number | null; trackerExpected: boolean; renamed: boolean;
};

const r1 = (n: number) => Math.round(Math.max(0, n) * 10) / 10;

export function scoreParts(x: In): ScorePart[] {
  const parts: ScorePart[] = [];

  const q = x.quality === null ? 70 : Math.min(100, Math.max(0, x.quality));
  parts.push({ label: "Quality of the information", of: 40, got: r1((q / 100) * 40), note: x.quality === null ? "not judged; counted as 70%" : `${Math.round(q)}% on detail, accuracy, follow-up and what was seen` });

  // photos: enough of them (fresh ones), the same size, none stretched or sideways, big and sharp enough
  const p = x.photos, fresh = Math.max(0, p.count - p.reused);
  const enough = p.expected ? Math.min(1, fresh / p.expected) * 4 : 4;
  const same = p.mixed ? 0 : 2;
  const shape = Math.max(0, 2 - 0.5 * (p.stretched + p.sideways));
  const clear = Math.max(0, 2 - 0.25 * (p.small + p.blurry));
  const photoNotes = [
    p.expected ? `${p.count} photo${p.count === 1 ? "" : "s"}${p.reused ? ` (${p.reused} reused)` : ""} against ${p.expected} expected` : `${p.count} photos`,
    p.mixed ? "different sizes" : "", p.stretched ? `${p.stretched} stretched` : "", p.sideways ? `${p.sideways} sideways` : "",
    p.small ? `${p.small} too small` : "", p.blurry ? `${p.blurry} low detail` : "",
  ].filter(Boolean);
  parts.push({ label: "Photos", of: 10, got: r1(enough + same + shape + clear), note: photoNotes.join(", ") });

  // spelling: 1.5 marks off per mistake per 1,000 words
  const per1000 = x.words ? (x.spelling / x.words) * 1000 : x.spelling;
  parts.push({ label: "Spelling and grammar", of: 10, got: r1(10 - 1.5 * per1000), note: `${x.spelling} mistake${x.spelling === 1 ? "" : "s"} in about ${x.words.toLocaleString("en-GB")} words` });

  if (!x.hs) parts.push({ label: "Health and safety items", of: 10, got: 10, note: "not judged for this report" });
  else {
    const n = x.hs.length || 10, ok = x.hs.filter((h) => h.status === "ok").length, thin = x.hs.filter((h) => h.status === "thin").length;
    parts.push({ label: "Health and safety items", of: 10, got: r1(((ok + thin * 0.5) / n) * 10), note: `${ok} of ${n} filled in properly${thin ? `, ${thin} just "N/A"/"none"` : ""}` });
  }

  const pv = x.programme?.verdict;
  const prog = !pv || pv === "good" || pv === "not_in_form" ? 10 : pv === "missing" ? 0 : Math.max(2, 10 - 2 * x.programmeGaps);
  parts.push({ label: x.programme && !x.programme.dfe ? "Progress summary" : "Progress vs programme", of: 10, got: prog, note: !pv || pv === "not_in_form" ? "not part of this report" : pv === "good" ? "done the Beamore way" : pv === "missing" ? "not done" : `${x.programmeGaps} thing${x.programmeGaps === 1 ? "" : "s"} short of the method` });

  const vals = Object.values(x.standards ?? {});
  parts.push({ label: "Best practices", of: 10, got: vals.length ? r1((vals.filter(Boolean).length / vals.length) * 10) : 10, note: vals.length ? `${vals.filter(Boolean).length} of ${vals.length}` : "not judged" });

  // tracker 7 (2 off per kind of problem; none at all when one's expected = 0), file name 3
  const trk = x.tracker === null ? (x.trackerExpected ? 0 : 7) : Math.max(0, 7 - 2 * x.tracker);
  parts.push({ label: "Issues tracker and file name", of: 10, got: r1(trk + (x.renamed ? 0 : 3)), note: [x.tracker === null ? (x.trackerExpected ? "no issues tracker" : "") : x.tracker ? `${x.tracker} kind${x.tracker === 1 ? "" : "s"} of tracker problem` : "tracker done right", x.renamed ? "file name didn't follow the folder's pattern" : "file name right"].filter(Boolean).join("; ") });

  return parts;
}

export const scoreTotal = (parts: ScorePart[]) => Math.round(parts.reduce((n, p) => n + p.got, 0));
