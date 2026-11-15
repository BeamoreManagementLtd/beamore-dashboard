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
    // no names in anything the clerks see (Ronan, 15 Nov 2026: "don't reference other peoples reports and don't
    // reference other people")
    marker: "[Example – photos]",
    file: "example-photos.jpg",
    intro: "This is the photo layout we're after: all the same size, two to a line, with what they show written alongside:",
    caption: "Photos the same size, two to a line, specific notes alongside",
  },
  detail: {
    marker: "[Example – detail]",
    file: "example-detail.jpg",
    intro: "And this is the kind of detail we're after: a short heading for each thing, then exactly what was seen, where and what's in place:",
    caption: "A heading for each item, then what was seen, where and how it's controlled",
  },
  // Ronan's "Site Diaries" email to all clerks, 8 Aug 2024, agreed with Mott MacDonald for the DfE jobs
  programme: {
    marker: "[Example – progress vs programme]",
    file: "example-progress.png",
    intro: "This is the progress vs programme section we want in every report:",
    caption: "Progress vs programme done the Beamore way: each activity's weeks ahead or behind, the causes, and an overall estimate",
  },
} as const;

/** Ronan's method for the progress vs programme section, as it goes in the email to a clerk. */
export const PROGRAMME_METHOD = [
  "How to do the progress vs programme section:",
  "- Say which programme you're working from (title and revision/date)",
  "- Pick 8-10 items off the programme, preferably on the critical path",
  "- Do your own independent check of where each one actually is: don't just take the site team's figures, they often exaggerate",
  "- Say how many weeks ahead or behind each one is, e.g. \"Installation of staircases – 3 weeks behind\", \"Ground beams – 2 weeks behind\". Work it out from the programme (e.g. windows 25 weeks long, programme 80%, actually 60%: 20% behind = 5 weeks behind)",
  "- Then write at least 5-6 lines taking all the items into account: how far behind or ahead each is, why, and where you think the project is overall, e.g. \"I estimate that the contractor is 3.5 weeks behind programme.\"",
];

/** For other clients' reports: the progress summary, as Damian Breen and Keith Osorio do it. */
export const SUMMARY_METHOD = [
  "How to do the progress summary at the start of the report:",
  "- Go area by area, level by level and trade by trade: what has progressed since the last visit",
  "- Say what's complete and what's still outstanding",
  "- Give the completion target and whether you think it's realistic, and why",
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
