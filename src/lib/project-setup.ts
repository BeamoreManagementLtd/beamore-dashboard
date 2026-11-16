import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { setupProjectTracking } from "@/lib/xero-tracking";
import { INFO_DFE, INFO_STANDARD, INFO_RETIRED, INFO_MERGED } from "@/lib/project-info";

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
  const msg = `${p.drive_folder_id ? "Checked the" : reused ? "Using the existing" : "Created"} folder Work/${spec.parent}/${p.name} (${spec.label})${added.length ? `; added ${added.join(", ")}` : "; subfolders already there"}`;
  await log(admin, projectId, "Drive folder", msg);
  return msg;
}

export const infoRequestSubject = (name: string) => `${name}: project information needed`;

/**
 * The automatic checklist matches DfE or not (Ronan, 16 Nov 2026: Tang Hall Primary was added as won before the
 * DfE check ran, got the standard list, and the draft never asked for the DfE project manager etc). Swaps the
 * other list's untouched automatic items for this list's; anything already asked for, received or added by hand stays.
 */
export async function matchChecklist(admin: SupabaseClient, projectId: string) {
  const { data: p } = await admin.from("projects").select("is_dfe").eq("id", projectId).single();
  // until we know whether it's a DfE job, only items no longer asked for are taken off
  const known = p?.is_dfe != null;
  const want = !known ? [] : p.is_dfe ? INFO_DFE : INFO_STANDARD, other = !known ? [] : p.is_dfe ? INFO_STANDARD : INFO_DFE;
  const { data: items } = await admin.from("project_info").select("id,item,auto,requested_on,received_on").eq("project_id", projectId);
  if (!items?.length || !items.some((i) => i.auto)) return false; // no automatic checklist to match
  // old separate items become the one combined item, keeping progress: received if every old one was received, asked
  // for if any was. Only automatic items; hand-added ones are left alone.
  let merged = false;
  for (const [to, from] of Object.entries(INFO_MERGED)) {
    const old = items.filter((i) => i.auto && from.includes(i.item));
    if (!old.length) continue;
    const latest = (k: "requested_on" | "received_on") => old.map((i) => i[k] as string | null).filter(Boolean).sort().pop() ?? null;
    const received = old.every((i) => i.received_on) ? latest("received_on") : null;
    if (!items.some((i) => i.item === to)) await admin.from("project_info").insert({ project_id: projectId, item: to, auto: true, requested_on: latest("requested_on"), received_on: received });
    await admin.from("project_info").delete().in("id", old.map((i) => i.id));
    await log(admin, projectId, "Checklist", `${old.map((i) => i.item).join(" and ")} are now one item: ${to}${received ? " (received)" : ""}`);
    merged = true;
  }
  if (merged) return matchChecklist(admin, projectId);
  const drop = items.filter((i) => i.auto && !i.received_on && ((!i.requested_on && other.includes(i.item) && !want.includes(i.item)) || INFO_RETIRED.includes(i.item)));
  const add = want.filter((w) => !items.some((i) => i.item.toLowerCase() === w.toLowerCase()));
  if (!drop.length && !add.length) return false;
  const retired = drop.filter((i) => INFO_RETIRED.includes(i.item)), switched = drop.filter((i) => !INFO_RETIRED.includes(i.item));
  if (drop.length) await admin.from("project_info").delete().in("id", drop.map((i) => i.id));
  if (add.length) await admin.from("project_info").insert(add.map((item) => ({ project_id: projectId, item, auto: true })));
  if (add.length || switched.length) await log(admin, projectId, "Checklist started", `Checklist changed to the ${p?.is_dfe ? "DfE" : "standard"} list: added ${add.join(", ") || "nothing"}${switched.length ? `; took off ${switched.map((i) => i.item).join(", ")} (not asked for yet)` : ""}`);
  if (retired.length) await log(admin, projectId, "Checklist", `Took ${retired.map((i) => i.item).join(", ")} off the checklist: no longer asked for (the client sent it for pricing)`);
  return true;
}

/** An email the dashboard has written: saved as a Gmail draft, or shown on screen to copy (Ronan, 16 Nov 2026). */
export type Email = { to: string; cc?: string; subject: string; body: string; threadId?: string; inReplyTo?: string };

export async function saveDraft(admin: SupabaseClient, e: Email) {
  const g = await driveClient(admin);
  const headers = [e.to && `To: ${e.to}`, e.cc && `Cc: ${e.cc}`, `Subject: ${e.subject}`, e.inReplyTo && `In-Reply-To: ${e.inReplyTo}`, e.inReplyTo && `References: ${e.inReplyTo}`,
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8"].filter(Boolean);
  const CRLF = String.fromCharCode(13, 10);
  const raw = headers.join(CRLF) + CRLF + CRLF + e.body.split(/\r?\n/).join(CRLF);
  return g.post<{ id: string; message: { threadId: string } }>("https://gmail.googleapis.com/gmail/v1/users/me/drafts",
    { message: { raw: Buffer.from(raw).toString("base64url"), ...(e.threadId ? { threadId: e.threadId } : {}) } });
}

/** S2: the email to the client listing what we need (as a reply in their thread when there is one). */
export async function composeInfoRequest(admin: SupabaseClient, projectId: string): Promise<Email> {
  await matchChecklist(admin, projectId);
  const { data: p } = await admin.from("projects").select("id,name,client_id,is_dfe").eq("id", projectId).single();
  if (!p) throw new Error("project not found");
  const [{ data: items }, { data: reply }, { data: contacts }] = await Promise.all([
    admin.from("project_info").select("item,requested_on").eq("project_id", projectId).is("received_on", null).order("created_at"),
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
  const chasing = (items ?? []).some((i) => i.requested_on);
  // Ronan's wording (16 Nov 2026)
  const body = chasing
    ? `Hi\n\nJust following up on the information for ${p.name}. We're still waiting on:\n\n${list}\n\nCould you send these over when you get a moment?\n\nRegards\n\nRonan O'Boyle\nBeamore Management Ltd`
    : `Hi\n\nSo we can get set up for ${p.name}, could you please send us the following:\n\n${list}\n\nRegards\n\nRonan O'Boyle\nBeamore Management Ltd`;
  return { to, subject, body, threadId, inReplyTo };
}

/** S2: the same email saved as a Gmail draft. Only ever a draft. */
export async function draftInfoRequest(admin: SupabaseClient, projectId: string) {
  const e = await composeInfoRequest(admin, projectId);
  const d = await saveDraft(admin, e);
  const msg = `Draft saved in your Gmail Drafts${e.to ? ` to ${e.to}` : " (no address found, add one)"}: "${e.subject}". It is not sent until you press Send`;
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

/** P4: the email following up a cost proposal, as a reply in the thread it went out in. */
export async function composeProposalFollowUp(admin: SupabaseClient, projectId: string): Promise<Email> {
  const { data: p } = await admin.from("projects").select("name,stage_changed_at").eq("id", projectId).single();
  if (!p) throw new Error("project not found");
  const g = await driveClient(admin);
  const found = await g.gmail<{ messages?: { id: string; threadId: string }[] }>("messages", { q: `in:sent subject:"${p.name.replace(/"/g, "")}" (proposal OR fee OR quote OR quotation)`, maxResults: "1" });
  const m = found.messages?.[0];
  if (!m) throw new Error(`no sent proposal for "${p.name}" found in your sent email`);
  const full = await g.gmail<{ internalDate: string; payload: { headers: { name: string; value: string }[] } }>(`messages/${m.id}`, { format: "metadata", metadataHeaders: ["To", "Cc", "Subject", "Message-ID"] });
  const h = (n: string) => full.payload.headers.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value ?? "";
  const sent = new Date(Number(full.internalDate)).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const body = `Hello,\n\nJust following up on our fee proposal for ${p.name}, sent on ${sent}. Please let me know if you have any questions, or if you'd like us to go ahead.\n\nMany thanks,\nRonan\n\nRonan O'Boyle\nBeamore Management Ltd`;
  return { to: h("To"), cc: h("Cc") || undefined, subject: `Re: ${h("Subject").replace(/^re:s*/i, "")}`, body, threadId: m.threadId, inReplyTo: h("Message-ID") || undefined };
}

/** P4: the same email saved as a Gmail draft. Only ever a draft. */
export async function draftProposalFollowUp(admin: SupabaseClient, projectId: string) {
  const e = await composeProposalFollowUp(admin, projectId);
  await saveDraft(admin, e);
  const h = (n: string) => (n === "To" ? e.to : "");
  const msg = `Follow-up draft saved in your Gmail Drafts to ${h("To")}. It is not sent until you press Send`;
  await admin.from("project_events").insert({ project_id: projectId, source: "dashboard", kind: "Follow-up drafted", who: "Dashboard", body: msg });
  return msg;
}

type Part = { filename?: string; mimeType?: string; body?: { attachmentId?: string; size?: number }; parts?: Part[] };
const flatten = (p?: Part): Part[] => (p ? [p, ...(p.parts ?? []).flatMap(flatten)] : []);

/**
 * S5: attachments the client emails about the project are saved into its Drive folder (CPs into "CPs",
 * photos into "Photos", everything else at the top of the project folder). Only for projects won since
 * the workflows began, only emails from outside Beamore since then, each attachment once. Logos, signature
 * images and calendar invites are skipped. Never deletes or moves anything.
 */
export async function saveProjectAttachments(admin: SupabaseClient, projectId: string) {
  const { data: p } = await admin.from("projects").select("name,drive_folder_id,stage_changed_at").eq("id", projectId).single();
  if (!p?.drive_folder_id || !p.stage_changed_at) return 0;
  const g = await driveClient(admin);
  const since = Math.floor(Date.parse(p.stage_changed_at) / 1000);
  const found = await g.gmail<{ messages?: { id: string }[] }>("messages", { q: `subject:"${p.name.replace(/"/g, "")}" has:attachment -from:me after:${since}`, maxResults: "10" });
  if (!found.messages?.length) return 0;
  const { data: done } = await admin.from("saved_attachments").select("message_id,attachment_name").eq("project_id", projectId);
  const have = new Set((done ?? []).map((d) => `${d.message_id}|${d.attachment_name}`));
  const subs = await children(g, p.drive_folder_id);
  const sub = (name: string) => subs.find((s) => same(s.name, name))?.id ?? p.drive_folder_id!;
  let saved = 0;
  for (const m of found.messages) {
    const full = await g.gmail<{ payload: Part & { headers: { name: string; value: string }[] } }>(`messages/${m.id}`, { format: "full" });
    const from = full.payload.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
    if (/beamore\.co\.uk/i.test(from)) continue;
    const names: string[] = [];
    for (const part of flatten(full.payload)) {
      const name = part.filename?.trim();
      const aid = part.body?.attachmentId;
      if (!name || !aid || have.has(`${m.id}|${name}`)) continue;
      const image = /^image\//.test(part.mimeType ?? "");
      if ((image && (part.body?.size ?? 0) < 40_000) || /\.ics$|^image0\d+\./i.test(name)) continue; // logos, signatures, invites
      const att = await g.gmail<{ data: string }>(`messages/${m.id}/attachments/${aid}`, {});
      const folder = /\bCPs?\b|contractor.?s? proposal/i.test(name) ? sub("CPs") : image ? sub("Photos") : p.drive_folder_id;
      const boundary = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [folder] })}\r\n--${boundary}\r\nContent-Type: ${part.mimeType || "application/octet-stream"}\r\n\r\n`),
        Buffer.from(att.data, "base64url"),
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const up = await g.upload(body, `multipart/related; boundary=${boundary}`);
      await admin.from("saved_attachments").insert({ message_id: m.id, attachment_name: name, project_id: projectId, drive_file_id: up.id });
      names.push(name);
      saved++;
    }
    if (names.length) await log(admin, projectId, "Files saved", `Saved ${names.length} attachment${names.length > 1 ? "s" : ""} from ${from.replace(/<.*>/, "").trim()} into the Drive folder: ${names.join(", ").slice(0, 250)}`);
  }
  return saved;
}

/**
 * Give an allocated clerk the project's Drive folder (Ronan, 16 Nov 2026): shared with their Beamore address as an editor,
 * no Google notification email. Makes the folder first if the project hasn't got one. Never removes anyone's access.
 */
export async function shareFolderWithClerk(admin: SupabaseClient, projectId: string, clerkId: string) {
  const { data: c } = await admin.from("clerks").select("name,email").eq("id", clerkId).maybeSingle();
  const email = (c?.email as string | null)?.trim().toLowerCase();
  if (!email) { await log(admin, projectId, "Drive folder", `Not shared with ${c?.name ?? "the clerk"}: no email address on their Personnel record`); return; }
  let folderId = (await admin.from("projects").select("drive_folder_id").eq("id", projectId).single()).data?.drive_folder_id as string | null;
  if (!folderId) { await ensureProjectFolder(admin, projectId); folderId = (await admin.from("projects").select("drive_folder_id").eq("id", projectId).single()).data?.drive_folder_id ?? null; }
  if (!folderId) throw new Error("the project has no Drive folder");
  const g = await driveClient(admin);
  const perms = (await g.json<{ permissions: { emailAddress?: string }[] }>(`files/${folderId}/permissions`, { supportsAllDrives: "true", fields: "permissions(emailAddress)" })).permissions;
  if (perms.some((x) => x.emailAddress?.toLowerCase() === email)) { await log(admin, projectId, "Drive folder", `${c?.name} already has the project folder`); return; }
  await g.post(`https://www.googleapis.com/drive/v3/files/${folderId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, { type: "user", role: "writer", emailAddress: email });
  await log(admin, projectId, "Drive folder", `Project folder shared with ${c?.name} (${email}), can edit`);
}
