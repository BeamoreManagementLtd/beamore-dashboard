/**
 * The AI feedback email to a clerk, laid out like the feedback page (Ronan, 17 Nov 2026: "more aesthetically pleasing,
 * like the feedback that we see on the dashboard... it's just hard to read all that"): the score, each part with a bar,
 * what was fixed, the suggestions and a button to the portal. HTML with inline styles (email apps ignore style sheets),
 * plus a plain-text version.
 */
type Part = { label: string; of: number; got: number; note?: string; improve?: string };
export type FeedbackReport = {
  id: string; file_name: string; score: number | null; clerk_points: string[] | null;
  fixes: { spelling?: { find: string; replace: string }[]; uniform?: number; stretched?: number; enlarged?: number; shrunk?: number; renamed?: string | null; score_parts?: Part[] } | null;
};

const OFFICE = /\b(checker|the office|office pc|fit to send|before (it is |it's )?sent|before sending|send it|invoice|fee|rate|ronan|judy|an[eé]l)\b/i;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n1 = (n: number) => (Math.round(n * 10) / 10).toString();
const colour = (share: number) => (share >= 0.8 ? "#1c784c" : share >= 0.55 ? "#c27c0e" : "#b1322a");

/**
 * precheck: the clerk checked a draft themselves before uploading it (Ronan, 18 Nov 2026): nothing was changed, so the
 * spelling slips are listed for them to correct, and they're reminded to upload the final report to Google Drive.
 */
export function feedbackEmail(r: FeedbackReport, o: { first: string; job: string; site: string; example?: string | null; precheck?: boolean }) {
  const f = r.fixes ?? {};
  const name = r.file_name.replace(/\.docx?$/i, "");
  const score = r.score === null || r.score === undefined ? null : Math.round(Number(r.score));
  const parts = (f.score_parts ?? []).filter((x) => x.of > 0);
  const points = (r.clerk_points ?? []).filter((t) => !OFFICE.test(t));
  const fixed = [
    f.spelling?.length ? `${f.spelling.length} spelling or typing slip${f.spelling.length === 1 ? "" : "s"} corrected` : "",
    f.uniform ? `${f.uniform} photo${f.uniform === 1 ? "" : "s"} set to the same size as the others` : "",
    f.stretched ? `${f.stretched} stretched photo${f.stretched === 1 ? "" : "s"} put back to the right shape` : "",
    f.enlarged ? `${f.enlarged} small photo${f.enlarged === 1 ? "" : "s"} made bigger` : "",
    f.shrunk ? `${f.shrunk} photo${f.shrunk === 1 ? "" : "s"} made smaller in file size` : "",
    f.renamed ? `File name changed to match the others in the folder: ${f.renamed.replace(/\.docx?$/i, "")}` : "",
  ].filter(Boolean);
  const pre = !!o.precheck;
  const slips = (f.spelling ?? []).map((x) => `"${x.find}" → "${x.replace}"`);
  const link = `${o.site}/portal/reports/${pre ? "check/" : ""}${r.id}`;
  const subject = `${o.example ? "[Example] " : ""}${pre ? `Pre-check of your ${o.job} report (not uploaded yet)` : `AI feedback on your ${o.job} report`}`;
  const preNote = "Nothing in your report has been changed, and it hasn't gone to Google Drive or the office. When you've put right anything you want to, please upload the final report to the job's Google Drive folder as normal.";
  const note = "This is AI feedback, based on what Beamore asks for in a report. It's there to help, not to judge, so please don't take it all to heart. AI can make mistakes, and some points may not apply to your job. The score is only there so you can see your own improvement over time, not to compare with anyone else.";

  // plain text
  const text = [
    ...(o.example ? [`(${o.example})`, ""] : []),
    `Hi ${o.first}`, "",
    pre ? `Here's the pre-check you asked for on your report (${name})${score !== null ? `. As it stands it would score ${score} out of 100` : ""}.` : `The AI feedback on your report (${name}) is ready${score !== null ? `. It scored ${score} out of 100` : ""}.`, "",
    ...(pre ? [preNote, ""] : []),
    ...(parts.length ? ["HOW EACH PART DID", ...parts.map((x) => `- ${x.label}: ${n1(x.got)} of ${x.of}${x.improve ? `. Tip: ${x.improve}` : ""}`), ""] : []),
    ...(pre ? ["SUGGESTIONS", ...(points.length ? points.map((x) => `- ${x}`) : ["- None: it looks good."]), "",
      "SPELLING AND TYPING SLIPS TO CORRECT", ...(slips.length ? slips.slice(0, 40).map((x) => `- ${x}`) : ["- None found."]), ""]
      : ["WHAT WAS FIXED FOR YOU", ...(fixed.length ? fixed.map((x) => `- ${x}`) : ["- Nothing needed fixing."]), "",
        "SUGGESTIONS", ...(points.length ? points.map((x) => `- ${x}`) : ["- None this time."]), ""]),
    `See it in the clerk portal${pre ? "" : " (with a graph of your scores)"}: ${link}`, "", note, "",
    ...(pre ? [] : ["You can switch these emails and the feedback off at any time under Your reports in the portal.", ""]), "Beamore Management",
  ].join("\n");

  // HTML
  const row = (x: Part) => {
    const share = x.of ? x.got / x.of : 0, c = colour(share);
    return `<tr><td style="padding:10px 0;border-bottom:1px solid #eeeeee">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="font-size:14px;color:#2b2b2b;font-weight:600">${esc(x.label)}</td>
        <td align="right" style="font-size:14px;color:${c};font-weight:700;white-space:nowrap">${n1(x.got)} / ${x.of}</td></tr>
      <tr><td colspan="2" style="padding-top:6px"><div style="background:#eeeeee;border-radius:4px;height:8px;width:100%"><div style="background:${c};border-radius:4px;height:8px;width:${Math.max(3, Math.round(share * 100))}%"></div></div></td></tr>
      ${x.improve && share < 1 ? `<tr><td colspan="2" style="padding-top:6px;font-size:13px;color:#6b6b6b;line-height:1.45">${esc(x.improve)}</td></tr>` : ""}
      </table></td></tr>`;
  };
  const list = (items: string[], empty: string) => items.length
    ? `<ul style="margin:6px 0 0;padding-left:20px">${items.map((t) => `<li style="font-size:14px;color:#2b2b2b;line-height:1.5;margin:0 0 6px">${esc(t)}</li>`).join("")}</ul>`
    : `<p style="margin:6px 0 0;font-size:14px;color:#6b6b6b">${empty}</p>`;
  const spellingEg = f.spelling?.length ? `<p style="margin:2px 0 0 20px;font-size:13px;color:#6b6b6b">e.g. ${f.spelling.slice(0, 4).map((s) => `&ldquo;${esc(s.find)}&rdquo; &rarr; &ldquo;${esc(s.replace)}&rdquo;`).join(", ")}</p>` : "";
  const sc = score === null ? "#6b6b6b" : colour(score / 100);
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;border:1px solid #e2e2e2">
${o.example ? `<tr><td style="background:#fbeed6;color:#a4620a;font-size:13px;padding:10px 24px;border-radius:10px 10px 0 0">${esc(o.example)}</td></tr>` : ""}
<tr><td style="padding:22px 24px 6px;border-top:4px solid #da4444;${o.example ? "" : "border-radius:10px 10px 0 0;"}">
  <p style="margin:0;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#da4444;font-weight:700">Beamore Management &middot; ${pre ? "Pre-check before uploading" : "AI feedback"}</p>
  <h1 style="margin:6px 0 2px;font-size:22px;color:#2b2b2b">${esc(o.job)}</h1>
  <p style="margin:0;font-size:13px;color:#6b6b6b">${esc(name)}</p>
</td></tr>
<tr><td style="padding:14px 24px 4px"><p style="margin:0;font-size:15px;color:#2b2b2b;line-height:1.5">Hi ${esc(o.first)}, here&rsquo;s the ${pre ? "pre-check you asked for on your report" : "AI feedback on your report"}.</p></td></tr>
${pre ? `<tr><td style="padding:10px 24px 0"><div style="background:#fbeed6;color:#7a4a08;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.5"><b>Not uploaded yet.</b> ${esc(preNote)}</div></td></tr>` : ""}
${score !== null ? `<tr><td style="padding:12px 24px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f7;border-radius:8px"><tr>
    <td style="padding:14px 18px;font-size:13px;color:#6b6b6b">${pre ? "Score as it stands" : "Score"}</td>
    <td align="right" style="padding:14px 18px"><span style="font-size:34px;font-weight:700;color:${sc}">${score}</span><span style="font-size:15px;color:#6b6b6b"> / 100</span></td>
  </tr></table></td></tr>` : ""}
${parts.length ? `<tr><td style="padding:8px 24px 0"><h2 style="margin:0;font-size:16px;color:#2b2b2b">How each part did</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${parts.map(row).join("")}</table></td></tr>` : ""}
${pre ? `<tr><td style="padding:18px 24px 0"><h2 style="margin:0;font-size:16px;color:#2b2b2b">Suggestions</h2>${list(points, "No suggestions: it looks good.")}</td></tr>
<tr><td style="padding:18px 24px 0"><h2 style="margin:0;font-size:16px;color:#2b2b2b">Spelling and typing slips to correct</h2>${list(slips.slice(0, 40), "None found.")}</td></tr>`
  : `<tr><td style="padding:18px 24px 0"><h2 style="margin:0;font-size:16px;color:#2b2b2b">What was fixed for you</h2>${list(fixed, "Nothing needed fixing.")}${spellingEg}</td></tr>
<tr><td style="padding:18px 24px 0"><h2 style="margin:0;font-size:16px;color:#2b2b2b">Suggestions</h2>${list(points, "No suggestions this time.")}</td></tr>`}
<tr><td align="center" style="padding:22px 24px 6px"><a href="${esc(link)}" style="display:inline-block;background:#2b2b2b;color:#ffffff;text-decoration:none;font-size:14px;font-weight:700;padding:12px 22px;border-radius:8px">See it in the clerk portal</a>
  ${pre ? "" : `<p style="margin:8px 0 0;font-size:12px;color:#6b6b6b">with a graph of your scores and your earlier reports</p>`}</td></tr>
<tr><td style="padding:16px 24px 6px"><div style="background:#eaeef2;color:#56616e;border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.5">${esc(note)}</div></td></tr>
<tr><td style="padding:10px 24px 22px;font-size:12px;color:#6b6b6b;line-height:1.5">${pre ? "" : "You can switch these emails and the feedback off at any time under <b>Your reports</b> in the clerk portal.<br>"}Beamore Management</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
