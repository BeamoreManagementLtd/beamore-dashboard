import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { setupProjectTracking } from "@/lib/xero-tracking";
import { INFO_DFE, INFO_STANDARD } from "@/lib/project-info";

/**
 * What happens when a project is won (docs/workflows.html, S2/S4/S7):
 *  - its folder in Google Drive: My Drive/Work/Schools (DfE and other schools) or Work/Others, named after the
 *    project like the existing ones ("Connaught", "Mote Mews"), with the subfolders that type of job uses;
 *    an existing folder of that name is reused and only missing subfolders are added
 *  - a Gmail DRAFT to the client asking for the checklist items (never sent: Ronan presses Send)
 *  - its Project tracking option in Xero
 * Each part is logged on the project and retried by the hourly job if Google or Xero wasn't available.
 * Nothing is ever deleted, moved or sent.
 */
import { FOLDER_KINDS, guessFolderKind, type FolderKind } from "@/lib/folder-kinds";
export { FOLDER_KINDS, guessFolderKind, type FolderKind };

const FOLDER = "application/vnd.google-apps.folder";
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
// "CPs", "CP's" and "Cp's" are the same folder
const same = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9&]/g, "") === b.toLowerCase().replace(/[^a-z0-9&]/g, "");

type G = Awaited<ReturnType<typeof driveClient>>;
async function children(g: G, parentId: string) {
  const r = await g.json<{ files: { id: string; name: string }[] }>("files", {
    q: `'${parentId}' in parents and mimeType = '${FOLDER}' and trashed = false`, fields: "files(id,name)", pageSize: "1000",
  });
  return r.files;
}
async function child(g: G, parentId: string, name: string) {
  return (await children(g, parentId)).find((f) => same(f.name, name));
}
async function mkdir(g: G, parentId: string, name: string) {
  return g.post<{ id: string }>("https://www.googleapis.com/drive/v3/files?fields=id", { name, mimeType: FOLDER, parents: [parentId] });
}

const log = (admin: SupabaseClient, project_id: string, kind: string, body: string) =>
  admin.from("project_events").insert({ project_id, source: "dashboard", kind, who: "Dashboard", body });

/** S4: the project's Drive folder. Returns a short message for the log. */
export async function ensureProjectFolder(admin: SupabaseClient, projectId: string) {
  const { data: p } = await admin.from("projects").select("id,name,is_dfe,folder_kind,drive_folder_id").eq("id", projectId).single();
  if (!p) throw new Error("project not found");
  const kind = (p.folder_kind as FolderKind | null) ?? guessFolderKind(p);
  const spec = FOLDER_KINDS[kind];
  const g = await driveClient(admin);
  const work = (await g.json<{ files: { id: string }[] }>("files", { q: `name = 'Work' and 'root' in parents and mimeType = '${FOLDER}' and trashed = false`, fields: "files(id)" })).files[0];
  if (!work) throw new Error('No "Work" folder at the top of My Drive');
  const parent = await child(g, work.id, spec.parent);
  if (!parent) throw new Error(`No "Work/${spec.parent}" folder in My Drive`);
  let folderId = p.drive_folder_id as string | null;
  let reused = false;
  if (!folderId) {
    const existing = (await children(g, parent.id)).find((f) => same(f.name, p.name));
    if (existing) { folderId = existing.id; reused = true; } else folderId = (await mkdir(g, parent.id, p.name)).id;
  }
  const have = await children(g, folderId);
  const added: string[] = [];
  for (const sub of spec.subfolders) if (!have.some((h) => same(h.name, sub))) { await mkdir(g, folderId, sub); added.push(sub); }
  await admin.from("projects").update({ drive_folder_id: folderId, folder_kind: kind }).eq("id", projectId);
  const msg = `${reused ? "Using the existing" : "Created"} folder Work/${spec.parent}/${p.name} (${spec.label})${added.length ? `; added ${added.join(", ")}` : "; subfolders already there"}`;
  await log(admin, projectId, "Drive folder", msg);
  return msg;
}

export const infoRequestSubject = (name: string) => `${name}: project information needed`;

/** S2: a Gmail draft to the client listing what we need. Only ever a draft. */
export async function draftInfoRequest(admin: SupabaseClient, projectId: string) {
  const { data: p } = await admin.from("projects").select("id,name,client_id,is_dfe").eq("id", projectId).single();
  if (!p) throw new Error("project not found");
  const [{ data: items }, { data: reply }, { data: contacts }] = await Promise.all([
    admin.from("project_info").select("item").eq("project_id", projectId).is("received_on", null).order("created_at"),
    admin.from("project_steps").select("note").eq("project_id", projectId).eq("step", "P4").maybeSingle(),
    admin.from("invoice_contacts").select("to_emails").or(`project_id.eq.${projectId}${p.client_id ? `,client_id.eq.${p.client_id}` : ""}`).limit(1),
  ]);
  const g = await driveClient(admin);
  // reply in the client's thread about the proposal when we have one; otherwise a new email to the invoice contacts
  let to = "", threadId: string | undefined, inReplyTo: string | undefined, subject = infoRequestSubject(p.name);
  if (reply?.note) {
    const t = await g.gmail<{ messages: { payload: { headers: { name: string; value: string }[] } }[] }>(`threads/${reply.note}`, { format: "metadata", metadataHeaders: ["From", "Reply-To", "Message-ID", "Subject"] });
    const h = (m: (typeof t.messages)[number], n: string) => m.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
    const theirs = [...t.messages].reverse().find((m) => !/beamore\.co\.uk/i.test(h(m, "From")));
    if (theirs) { to = h(theirs, "Reply-To") || h(theirs, "From"); threadId = reply.note; inReplyTo = h(theirs, "Message-ID"); subject = `Re: ${h(theirs, "Subject").replace(/^re:\s*/i, "")}`; }
  }
  if (!to) to = ((contacts?.[0]?.to_emails as string[] | undefined) ?? []).join(", ");
  const list = (items ?? []).map((i) => `- ${i.item}`).join("\n") || "- (add the items needed)";
  const body = `Hello,\n\nThank you for appointing Beamore on ${p.name}. So we can get set up, could you please send us the following:\n\n${list}\n\nMany thanks,\nRonan\n\nRonan O'Boyle\nBeamore Management Ltd`;
  const headers = [to && `To: ${to}`, `Subject: ${subject}`, inReplyTo && `In-Reply-To: ${inReplyTo}`, inReplyTo && `References: ${inReplyTo}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8"].filter(Boolean);
  const raw = `${headers.join("\r\n")}\r\n\r\n${body.replace(/\n/g, "\r\n")}`;
  const d = await g.post<{ id: string; message: { threadId: string } }>("https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    { message: { raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) } });
  const msg = `Draft saved in your Gmail Drafts${to ? ` to ${to}` : " (no address found, add one)"}: "${subject}". It is not sent until you press Send`;
  await log(admin, projectId, "Info request drafted", `${msg} [${d.message.threadId}]`);
  return msg;
}

/** Everything that happens on Won. Each part is independent; failures are logged and retried hourly. */
export async function onWon(admin: SupabaseClient, projectId: string) {
  const out: string[] = [];
  const attempt = async (what: string, f: () => Promise<string>) => {
    try { out.push(await f()); } catch (e) {
      const m = `${what} not done yet: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
      await log(admin, projectId, "Set-up problem", m);
      out.push(m);
    }
  };
  // the checklist first, so the draft can list it (DfE list when the project is DfE)
  const [{ data: p }, { count }] = await Promise.all([
    admin.from("projects").select("is_dfe,dfe_evidence").eq("id", projectId).single(),
    admin.from("project_info").select("id", { count: "exact", head: true }).eq("project_id", projectId),
  ]);
  if (!count && p) {
    await admin.from("project_info").insert((p.is_dfe ? INFO_DFE : INFO_STANDARD).map((item) => ({ project_id: projectId, item, auto: true })));
    await log(admin, projectId, "Checklist started", `${p.is_dfe ? "DfE" : "Standard"} checklist started when the project was won.${p.is_dfe == null ? " The DfE check hadn't run yet, so this is the standard list; change it if it's a DfE job." : ""}`);
  }
  await attempt("Drive folder", () => ensureProjectFolder(admin, projectId));
  await attempt("Info request draft", () => draftInfoRequest(admin, projectId));
  await attempt("Xero tracking", async () => { const r = await setupProjectTracking(admin); if (!r.ok) throw new Error(r.message); return r.message; });
  return out;
}
