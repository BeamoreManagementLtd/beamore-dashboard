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
    dfe: "Use the comments/note box at the top of the DfE diary (or the Summary section of the CQM monthly report) for a short progress summary: what's moved on, area by area, and what's outstanding",
  },
  detail: {
    label: "Specific detail",
    test: "Observations say where (the level and room, corridor or area; a gridline is fine but never needed), what was seen, which trade, and the control or action; even 'nothing to report' items are specific",
    tip: 'Make every observation specific: where (the level and room or area), what you saw, which trade, and what\'s in place or needs doing. Avoid a bare "N/A" or "Good"',
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
    dfe: "Keep the defects tracker at the end of the DfE form up to date: every item raised, with the report and date, and the date closed",
  },
  keep_under_review: {
    label: "Items to keep under review",
    test: "Ends with a short list of the open items the clerk will keep under review or a look-ahead for the next visit",
    tip: "Finish with a short list of the items you're keeping under review for next time",
    from: "Damian Breen's reports for The Forum",
    dfe: 'Use the "Look ahead for next month" box for the open items you\'re keeping under review and what you expect to see next time',
  },
  people: {
    label: "Weather and people",
    test: "Weather for each visit day, the contractor's management team by name, and the trades on site with numbers (a photo or screenshot of the site's sign-in system, e.g. Biosite, showing trades and numbers counts)",
    tip: "Record the weather for each visit day, the main contractor's team on site by name and each trade with numbers of operatives (a screenshot of the Biosite or sign-in system is fine for the trades)",
    from: "Damian Breen's reports for The Forum and Lewis Lucas's for Bloxwich",
    dfe: 'Fill in the People and Equipment boxes properly: weather for each visit day, the main contractor\'s team by name (the DfE asks for this), and each trade with numbers (not "see weekly reports"; a Biosite or sign-in system screenshot is fine for the trades)',
  },
} as const;

/**
 * DfE reports are on the DfE's own form, which Beamore can't change (Ronan, 15 Nov 2026): some boxes will be empty or
 * not apply, and nothing can be added outside the form. So for DfE reports each standard is done within the form
 * (the `dfe` wording where there is one). Other clients' reports are Beamore's own format, which can and should be
 * changed to include everything.
 */
export const tipFor = (k: StandardKey, dfe: boolean) => {
  const s = STANDARDS[k] as { tip: string; dfe?: string };
  return dfe && s.dfe ? s.dfe : s.tip;
};
export type StandardKey = keyof typeof STANDARDS;
export const STANDARD_KEYS = Object.keys(STANDARDS) as StandardKey[];

/** Which of the standards a report met, as the check records it (fixes.standards). */
export type StandardsMet = Partial<Record<StandardKey, boolean>>;
export const standardsShare = (s: StandardsMet | null | undefined) => {
  const keys = STANDARD_KEYS.filter((k) => typeof s?.[k] === "boolean");
  return keys.length ? keys.filter((k) => s![k]).length / keys.length : null;
};
