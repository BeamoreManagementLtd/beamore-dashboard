import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";

/**
 * The new clerk questionnaire (workflow 4): a private link, no login, that only that clerk has. What they enter goes
 * straight into their record, so the onboarding steps tick themselves; certificates go into their folder in
 * My Drive/Business/Beamore Management/Personnel/<Name> (made if missing). Nothing is deleted or sent.
 */
export const SITE = "https://dashboard.beamore.co.uk";
export const joinLink = (token: string) => `${SITE}/join/${token}`;
/** Beamore issues a helmet and a vest. */
export const PPE_ITEMS = ["Beamore helmet", "Beamore vest"];

export async function ensureJoinToken(admin: SupabaseClient, clerkId: string) {
  const { data } = await admin.from("clerk_compliance").select("join_token").eq("clerk_id", clerkId).maybeSingle();
  if (data?.join_token) return data.join_token as string;
  const token = randomBytes(24).toString("base64url");
  await admin.from("clerk_compliance").upsert({ clerk_id: clerkId, join_token: token, updated_at: new Date().toISOString() });
  return token;
}

const FOLDER = "application/vnd.google-apps.folder";
type G = Awaited<ReturnType<typeof driveClient>>;
async function sub(g: G, parent: string, name: string, create: boolean) {
  const q = `'${parent}' in parents and name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and mimeType = '${FOLDER}' and trashed = false`;
  const f = (await g.json<{ files: { id: string }[] }>("files", { q, fields: "files(id)" })).files[0];
  if (f || !create) return f?.id;
  return (await g.post<{ id: string }>("https://www.googleapis.com/drive/v3/files?fields=id", { name, mimeType: FOLDER, parents: [parent] })).id;
}

/** The clerk's documents folder: My Drive/Business/Beamore Management/Personnel/<Name>. */
export async function clerkFolder(admin: SupabaseClient, clerkId: string, name: string) {
  const { data } = await admin.from("clerk_compliance").select("documents_folder_id").eq("clerk_id", clerkId).maybeSingle();
  if (data?.documents_folder_id) return data.documents_folder_id as string;
  const g = await driveClient(admin);
  let at: string | undefined = "root";
  for (const step of ["Business", "Beamore Management", "Personnel"]) {
    at = await sub(g, at!, step, false);
    if (!at) throw new Error(`No "${step}" folder on the way to Business/Beamore Management/Personnel`);
  }
  const id = (await sub(g, at!, name, true))!;
  await admin.from("clerk_compliance").update({ documents_folder_id: id }).eq("clerk_id", clerkId);
  return id;
}

/** Saves an uploaded certificate into the clerk's folder. */
export async function uploadToFolder(admin: SupabaseClient, folderId: string, file: File, label: string) {
  const g = await driveClient(admin);
  const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")) : "";
  const name = `${label} - ${new Date().toISOString().slice(0, 10)}${ext}`;
  const boundary = `b${randomBytes(8).toString("hex")}`;
  const meta = JSON.stringify({ name, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`),
    Buffer.from(await file.arrayBuffer()),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  await g.upload(body, `multipart/related; boundary=${boundary}`);
  return name;
}

/** A Gmail draft to the clerk with their link. Only ever a draft. */
export async function draftJoinEmail(admin: SupabaseClient, clerkId: string) {
  const { data: c } = await admin.from("clerks").select("name,email").eq("id", clerkId).single();
  if (!c) throw new Error("clerk not found");
  const token = await ensureJoinToken(admin, clerkId);
  const first = c.name.split(" ")[0];
  const body = `Hi ${first},\n\nWelcome to Beamore. So we can get you set up, please fill in this short form with your details, insurance, DBS and CSCS card, and let us know what PPE you need:\n\n${joinLink(token)}\n\nYou can upload your certificates on the form. The link is just for you, so please don't share it.\n\nMany thanks,\nRonan\n\nRonan O'Boyle\nBeamore Management Ltd`;
  const headers = [c.email && `To: ${c.email}`, "Subject: Welcome to Beamore: your details", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8"].filter(Boolean);
  const raw = `${headers.join("\r\n")}\r\n\r\n${body.replace(/\n/g, "\r\n")}`;
  const g = await driveClient(admin);
  await g.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw: Buffer.from(raw).toString("base64url") } });
  return `Draft saved in your Gmail Drafts${c.email ? ` to ${c.email}` : " (no email address on file, add one)"}. It is not sent until you press Send`;
}
