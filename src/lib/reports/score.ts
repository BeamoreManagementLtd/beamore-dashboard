/**
 * A report's mark out of 100 (Ronan, 16 Nov 2026): judged on the report as the clerk sent it, before any corrections,
 * on everything agreed matters. A perfect report is 100 (10 out of 10); each slip costs marks in its own part, and
 * every part that lost marks says why and how to improve ("write beside the score why she was marked down").
 *   Quality of the information 40 · Photos 10 · Spelling and grammar 10 · Health and safety items 10 ·
 *   Progress vs programme / summary 10 · Best practices 10 · Issues tracker and file name 10
 */
export type ScorePart = { label: string; got: number; of: number; note: string; improve?: string };

type In = {
  /** the AI's judgement of the information: detail, accuracy, follow-up, seen v told (0-100), and why it lost marks */
  quality: number | null; qualityWhy?: string | null;
  /** expected: what a good report has (0 = not judged on numbers, e.g. a monthly report) */
  photos: { count: number; expected: number; mixed: boolean; stretched: number; small: number; blurry: number; sideways: number; reused: number };
  /** spelling and grammar mistakes the check found (with a few examples), and the report's length in words */
  spelling: number; spellingExamples?: string[]; words: number;
  /** the ten H&S items (null: not judged, e.g. the first reports on a job or the CQM monthly report) */
  hs: { label: string; status: string }[] | null;
  programme: { dfe: boolean; verdict: string; weekly_cqm?: boolean } | null; programmeGaps: number; programmeTips?: string[];
  standards: Record<string, boolean> | null; standardsMissed?: string[];
  /** tracker: kinds of problem found (photos in it, not coloured, closed without date/green/reason); null = no tracker */
  tracker: number | null; trackerProblems?: string[]; trackerExpected: boolean; renamed: boolean; renamedTo?: string | null;
};

const r1 = (n: number) => Math.round(Math.max(0, n) * 10) / 10;

// Softened (Ronan, 16 Nov 2026: "a little bit harsh in areas"; one slip in 1,735 words had cost 0.9):
/** Spelling: up to one mistake per 1,000 words costs nothing; then 1.25 marks per mistake per 1,000 words. */
export const spellingMark = (mistakes: number, words: number) => r1(10 - 1.25 * Math.max(0, (words ? (mistakes / words) * 1000 : mistakes) - 1));
/** Progress vs programme: not done 0; done but short of the method, 1 mark off per thing missing, never below 4. */
export const programmeMark = (verdict: string | undefined, gaps: number) => (!verdict || verdict === "good" || verdict === "not_in_form" ? 10 : verdict === "missing" ? 0 : Math.max(4, 10 - gaps));
/** Best practices: full marks for six of the eight; each one fewer costs its share. */
export const standardsMark = (met: number, of: number) => (of ? r1(Math.min(1, met / Math.max(1, of - 2)) * 10) : 10);
/** Photo shapes: half a mark per stretched photo. Photos that may be sideways are pointed out but cost nothing: that's
 * the AI's guess from small samples, and it has been wrong (Peter Lord's portrait photos, 15 Nov 2026). */
export const photoShapeMark = (stretched: number) => Math.max(0, 2 - 0.5 * stretched);
const list = (a: string[]) => (a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

export function scoreParts(x: In): ScorePart[] {
  const parts: ScorePart[] = [];

  const q = x.quality === null ? 70 : Math.min(100, Math.max(0, x.quality));
  parts.push({ label: "Quality of the information", of: 40, got: r1((q / 100) * 40), note: x.quality === null ? "not judged; counted as 70%" : `${Math.round(q)}% on detail, accuracy, follow-up and what was seen`,
    improve: q < 100 ? (x.qualityWhy || "Make every observation specific: where (the level and room or area), what was seen, which trade, and what's in place or needs doing") : undefined });

  // photos: enough of them (fresh ones), the same size, none stretched or sideways, big and sharp enough
  const p = x.photos, fresh = Math.max(0, p.count - p.reused);
  // (Ronan, 17 Nov 2026, after Damian's 276-photo report scored 4/10: "don't take marks off for having lots of photos;
  // take them off a little bit for irregular sizes"): plenty of photos is never a fault; mixed sizes cost 1 mark;
  // stretched photos cost nothing (the check straightens them); small or low-detail photos count as a share of all of them
  const enough = p.expected ? Math.min(1, fresh / p.expected) * 4 : 4;
  const same = p.mixed ? 1 : 2;
  const shape = 2;
  const clear = r1(2 * (1 - Math.min(1, ((p.small + p.blurry) / Math.max(1, p.count)) * 4)));
  const photoNotes = [
    // (Ronan, 18 Nov 2026: "41 against 20 expected" read as a fault; the figure is a minimum, and more is a good thing)
    p.expected ? `${p.count} photo${p.count === 1 ? "" : "s"}${p.reused ? ` (${p.reused} reused)` : ""}${fresh >= p.expected ? `, plenty (${p.expected} or more is the aim)` : `, short of the ${p.expected} or more aimed for`}` : `${p.count} photos`,
    p.mixed ? "different sizes" : "", p.stretched ? `${p.stretched} stretched (straightened, not marked down)` : "", p.sideways ? `${p.sideways} may be sideways (not marked down)` : "",
    p.small ? `${p.small} too small` : "", p.blurry ? `${p.blurry} low detail` : "",
  ].filter(Boolean);
  const photoTips = [
    enough < 4 ? (p.reused ? `Take fresh photos each visit (${p.reused} were the same as last time) and aim for at least ${p.expected}` : `Aim for at least ${p.expected} photos covering the areas described`) : "",
    p.mixed ? "Keep all photos the same size, about 6 cm wide, two to a line" : "",
    p.stretched ? "Resize photos from a corner so they don't stretch" : "",
    p.sideways ? "Check photos are the right way up before inserting them" : "",
    p.small || p.blurry ? "Use photos big and sharp enough to see clearly (about 6 cm wide)" : "",
  ].filter(Boolean);
  parts.push({ label: "Photos", of: 10, got: r1(enough + same + shape + clear), note: photoNotes.join(", "), improve: photoTips.join(". ") || undefined });

      const ex = (x.spellingExamples ?? []).slice(0, 4);
  parts.push({ label: "Spelling and grammar", of: 10, got: spellingMark(x.spelling, x.words), note: `${x.spelling} mistake${x.spelling === 1 ? "" : "s"} in about ${x.words.toLocaleString("en-GB")} words`,
    improve: spellingMark(x.spelling, x.words) < 10 ? `Run Word's spelling and grammar check before sending${ex.length ? ` (e.g. ${ex.join(", ")})` : ""}` : undefined });

  if (!x.hs) parts.push({ label: "Health and safety items", of: 10, got: 10, note: "not judged for this report" });
  else {
    const n = x.hs.length || 10, ok = x.hs.filter((h) => h.status === "ok").length, thin = x.hs.filter((h) => h.status === "thin");
    const gone = x.hs.filter((h) => h.status === "missing"), empty = x.hs.filter((h) => h.status === "empty");
    // "N/A" or "none" is fine when nothing of that kind is happening on site (Ronan, 20 Nov 2026: "there may not be any
    // excavation"): it counts in full; only an item taken out or left empty loses marks
    const why = [gone.length ? `${list(gone.map((h) => h.label))} taken out` : "", empty.length ? `${list(empty.map((h) => h.label))} left empty` : ""].filter(Boolean);
    parts.push({ label: "Health and safety items", of: 10, got: r1(((ok + thin.length) / n) * 10), note: `${ok + thin.length} of ${n} filled in${thin.length ? ` (${thin.length} "N/A", which is fine)` : ""}`,
      improve: why.length ? `${why.join("; ")}. Fill in all ${n} at the start of every report ("N/A" is fine where nothing of that kind is happening)` : undefined });
  }

  const pv = x.programme?.verdict;
  const prog = programmeMark(pv, x.programmeGaps);
  parts.push({ label: x.programme && !x.programme.dfe ? "Progress summary" : "Progress vs programme", of: 10, got: prog, note: x.programme?.weekly_cqm && pv === "not_in_form" ? "weekly CQM report: progress goes in the CQM monthly report" : !pv || pv === "not_in_form" ? "not part of this report" : pv === "good" ? "done the Beamore way" : pv === "missing" ? "not done" : `${x.programmeGaps} thing${x.programmeGaps === 1 ? "" : "s"} short of the method`,
    improve: prog < 10 ? ((x.programmeTips ?? []).join("; ") || "Follow the progress vs programme method") : undefined });

  const vals = Object.values(x.standards ?? {});
  const missed = x.standardsMissed ?? [];
  parts.push({ label: "Best practices", of: 10, got: standardsMark(vals.filter(Boolean).length, vals.length), note: vals.length ? `${vals.filter(Boolean).length} of ${vals.length}` : "not judged",
    improve: missed.length ? `Missing: ${list(missed.map((m) => m.toLowerCase()))}` : undefined });

  // tracker 7 (2 off per kind of problem; none at all when one's expected = 0), file name 3
  const trk = x.tracker === null ? (x.trackerExpected ? 0 : 7) : Math.max(0, 7 - 2 * x.tracker);
  const trkTips = [
    x.tracker === null && x.trackerExpected ? "Keep a running issues tracker at the end of every report" : "",
    ...(x.tracker ? (x.trackerProblems ?? []) : []),
    x.renamed ? `Name the file the same way as the others in the folder${x.renamedTo ? ` (e.g. "${x.renamedTo.replace(/\.docx?$/i, "")}")` : ""}` : "",
  ].filter(Boolean);
  parts.push({ label: "Issues tracker and file name", of: 10, got: r1(trk + (x.renamed ? 0 : 3)), note: [x.tracker === null ? (x.trackerExpected ? "no issues tracker" : "") : x.tracker ? `${x.tracker} kind${x.tracker === 1 ? "" : "s"} of tracker problem` : "tracker done right", x.renamed ? "file name didn't follow the folder's pattern" : "file name right"].filter(Boolean).join("; "),
    improve: trkTips.length ? trkTips.join("; ") : undefined });

  return parts;
}

export const scoreTotal = (parts: ScorePart[]) => Math.round(parts.reduce((n, p) => n + p.got, 0));
