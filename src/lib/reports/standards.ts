/**
 * The best bits of everyone's reports, made the standard for all (Ronan, 15 Nov 2026: "take the best bits of
 * everyone's reports and strive to make everyone hit those... I want everyone to do all the stuff well").
 * Each one names the clerk whose reports show it best, so the email to a clerk can say whose to look at.
 * Taken from Nov 2026 reports: Christian Tate (St Leonards), Damian Breen (The Forum), Keith Osorio (Holiday Inn
 * Camden), Nick Jenkin (Siemens), Lewis Lucas (Bloxwich), Andy Thomson (King Ethelbert), and Ronan's Aug 2024
 * progress vs programme email.
 */
export const STANDARDS = {
  summary: {
    label: "Progress summary up front",
    test: "Opens with a summary of the visit: progress area by area / level by level / trade by trade, what's complete, what's outstanding, and the completion date with the clerk's view on it",
    tip: "Open with a short progress summary: what's moved on since last time, area by area and level by level, what's still outstanding, and whether the completion date looks realistic",
    from: "Damian Breen's reports for The Forum and Keith Osorio's for Holiday Inn Camden",
  },
  detail: {
    label: "Specific detail",
    test: "Observations say where (building, level, room, gridline), what was seen, which trade, and the control or action; even 'nothing to report' items are specific",
    tip: 'Make every observation specific: where (level, room, gridline), what you saw, which trade, and what\'s in place or needs doing. Avoid a bare "N/A" or "Good"',
    from: "Christian Tate's reports (e.g. St Leonards)",
  },
  references: {
    label: "Checked against the drawings and specs",
    test: "Work is checked against named drawings, details, technical submittals, specifications, temporary works designs, regulations or certificates (e.g. 'as per detail WT18', 'drawing 260065-SK-0003 Rev C01', CARES certificates checked)",
    tip: "Say what you checked the work against: the drawing or detail number, the technical submittal, the temporary works design, or the certificates you looked at",
    from: "Damian Breen's reports for The Forum and Lewis Lucas's for Bloxwich",
  },
  follow_up: {
    label: "Follows up earlier reports",
    test: "Refers back to what earlier reports raised and says what has changed since (e.g. 'progressed from the stage noted in Report 80')",
    tip: "Follow up what you raised last time: say what's changed since your previous report and what's still outstanding",
    from: "Keith Osorio's reports for Holiday Inn Camden",
  },
  verified: {
    label: "Seen v told",
    test: "Makes clear what the clerk saw and checked for themselves versus what the site team said, and doesn't present the contractor's claims as fact",
    tip: "Make clear what you saw and checked yourself and what the site team told you, e.g. \"site management reported... this was not verified\"",
    from: "Keith Osorio's reports for Holiday Inn Camden",
  },
  tracker: {
    label: "Running issues tracker",
    test: "Has a running defects/issues tracker carried from report to report: number, report and date raised, the item, date closed and comments",
    tip: "Keep a running defects tracker at the end of every report: number, the report and date it was raised, the item, the date closed and comments",
    from: "Keith Osorio's reports for Holiday Inn Camden and Nick Jenkin's for Siemens",
  },
  keep_under_review: {
    label: "Items to keep under review",
    test: "Ends with a short list of the open items the clerk will keep under review or a look-ahead for the next visit",
    tip: "Finish with a short list of the items you're keeping under review for next time",
    from: "Damian Breen's reports for The Forum",
  },
  people: {
    label: "Weather and people",
    test: "Weather for each visit day, the contractor's management team, and the trades on site with numbers",
    tip: "Record the weather for each visit day, the contractor's team on site and each trade with numbers of operatives",
    from: "Damian Breen's reports for The Forum and Lewis Lucas's for Bloxwich",
  },
} as const;
export type StandardKey = keyof typeof STANDARDS;
export const STANDARD_KEYS = Object.keys(STANDARDS) as StandardKey[];

/** Which of the standards a report met, as the check records it (fixes.standards). */
export type StandardsMet = Partial<Record<StandardKey, boolean>>;
export const standardsShare = (s: StandardsMet | null | undefined) => {
  const keys = STANDARD_KEYS.filter((k) => typeof s?.[k] === "boolean");
  return keys.length ? keys.filter((k) => s![k]).length / keys.length : null;
};
