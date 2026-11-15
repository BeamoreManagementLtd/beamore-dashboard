import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Examples from the best reports, put into the emails to clerks (Ronan, 15 Nov 2026: "can you please have it a bit
 * more like this"). In the draft each is a line like "[Example: Christian Tate – photos]" that Anél, Judy or Andy can
 * keep, move or delete; when the email is sent it becomes the picture. The pictures are kept privately (storage
 * bucket "report-examples"), never on a public web address.
 */
export const EXAMPLES = {
  photos: {
    marker: "[Example: Christian Tate – photos]",
    file: "example-photos.jpg",
    intro: "This is how Christian lays out his photos: all the same size, two to a line, with what they show written alongside:",
    caption: "From Christian Tate's report: photos the same size, two to a line, specific notes alongside",
  },
  detail: {
    marker: "[Example: Christian Tate – detail]",
    file: "example-detail.jpg",
    intro: "And this is the kind of detail we're after: a short heading for each thing, then exactly what was seen, where and what's in place:",
    caption: "From Christian Tate's report: a heading for each item, then what was seen, where and how it's controlled",
  },
  // Ronan's "Site Diaries" email to all clerks, 8 Aug 2024, agreed with Mott MacDonald for the DfE jobs
  programme: {
    marker: "[Example: progress vs programme]",
    file: "example-progress.png",
    intro: "This is the progress vs programme section we want in every report (from Ronan's email to all clerks):",
    caption: "Progress vs programme done the Beamore way: each activity's weeks ahead or behind, the causes, and an overall estimate",
  },
} as const;

/** Ronan's method for the progress vs programme section, as it goes in the email to a clerk. */
export const PROGRAMME_METHOD = [
  "How to do the progress vs programme section:",
  "- Pick 7-10 activities off the programme that are running now, including a few on the critical path",
  "- Check what progress the programme says they should be at",
  "- Do your own independent check of where they actually are: don't just take the site team's figures, they often exaggerate",
  "- Work out how many weeks ahead or behind each one is (e.g. windows 25 weeks long, programme 80%, actually 60%: 20% behind = 5 weeks behind) and write it as weeks, e.g. \"Ground beams – 2 weeks behind\". Leave the percentages out of the report",
  "- Then write 7-10 lines on progress: what the issues are and what caused them",
  "- Finish with your estimate of how far behind (or ahead) the contractor is overall, roughly in line with the critical-path items, e.g. \"I estimate that the contractor is 3.5 weeks behind programme.\"",
];
export type ExampleKey = keyof typeof EXAMPLES;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The email as HTML, with each example line turned into its picture. Returns the pictures to put inside it. */
export async function withExamples(admin: SupabaseClient, body: string) {
  const used: ExampleKey[] = [];
  const html = body.split(/\r?\n/).map((line) => {
    const key = (Object.keys(EXAMPLES) as ExampleKey[]).find((k) => line.trim() === EXAMPLES[k].marker);
    if (!key) return line.trim() ? `<p style="margin:0 0 8px">${esc(line)}</p>` : "";
    if (!used.includes(key)) used.push(key);
    return `<p style="margin:8px 0 16px"><img src="cid:${key}@beamore" alt="${esc(EXAMPLES[key].caption)}" style="max-width:100%;border:1px solid #ccc"><br><small style="color:#666">${esc(EXAMPLES[key].caption)}</small></p>`;
  }).join("\n");
  const inline = [];
  for (const key of used) {
    const { data } = await admin.storage.from("report-examples").download(EXAMPLES[key].file);
    if (data) inline.push({ cid: `${key}@beamore`, name: EXAMPLES[key].file, mime: EXAMPLES[key].file.endsWith(".png") ? "image/png" : "image/jpeg", data: Buffer.from(await data.arrayBuffer()) });
  }
  return { html: `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45">${html}</div>`, inline };
}
