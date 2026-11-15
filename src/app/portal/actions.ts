"use server";
import { after } from "next/server";
import { randomUUID } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { processUpload } from "@/lib/portal/process";

type Kind = "invoice" | "insurance" | "qualification";
const MAX = 25 * 1024 * 1024;

/** Step 1 of an upload: a receipt and a one-time link to send the file straight to Beamore's private storage. */
export async function startUpload(a: { kind: Kind; docType: string | null; fileName: string; mime: string; bytes: number }) {
  const me = await requirePortalUser();
  if (!me.clerk) return { ok: false as const, message: "Only clerks can upload here." };
  if (me.viewingAs) return { ok: false as const, message: "You're viewing as this clerk, so uploads are switched off." };
  if (!["invoice", "insurance", "qualification"].includes(a.kind)) return { ok: false as const, message: "Unknown upload." };
  if (a.bytes > MAX) return { ok: false as const, message: "That file is over 25 MB. Please send a smaller copy or email it to us." };
  if (a.kind === "invoice" && !me.clerk.invoice_upload) return { ok: false as const, message: "Invoice upload isn't switched on for your account yet. Please email your invoice to Beamore." };
  const admin = createServiceClient();
  const receipt = randomUUID();
  const safe = a.fileName.replace(/[^\w.\- ()]+/g, "_").slice(-120) || "upload";
  const path = `${me.clerk.id}/${receipt}/${safe}`;
  const { error } = await admin.from("portal_uploads").insert({
    receipt, clerk_id: me.clerk.id, email: me.clerk.email, kind: a.kind, doc_type: a.docType?.slice(0, 60) ?? null,
    file_name: a.fileName.slice(0, 200), mime: a.mime.slice(0, 100), bytes: a.bytes, storage_path: path, status: "uploading",
  });
  if (error) return { ok: false as const, message: "Couldn't start the upload. Please try again." };
  const { data, error: e2 } = await admin.storage.from("portal-uploads").createSignedUploadUrl(path);
  if (e2 || !data) return { ok: false as const, message: "Couldn't start the upload. Please try again." };
  return { ok: true as const, receipt, path, token: data.token };
}

/** Step 2: the file has arrived. It's accepted now; filing and checks run straight after, in the background. */
export async function finishUpload(receipt: string) {
  const me = await requirePortalUser();
  if (!me.clerk) return { ok: false as const, message: "Only clerks can upload here." };
  const admin = createServiceClient();
  const { data: u } = await admin.from("portal_uploads").select("id,storage_path,status").eq("receipt", receipt).eq("clerk_id", me.clerk.id).maybeSingle();
  if (!u) return { ok: false as const, message: "Upload not found." };
  const dir = u.storage_path!.split("/").slice(0, -1).join("/");
  const { data: there } = await admin.storage.from("portal-uploads").list(dir);
  if (!there?.length) return { ok: false as const, message: "The file didn't arrive. Please try again." };
  if (u.status === "uploading") {
    await admin.from("portal_uploads").update({ status: "received", received_at: new Date().toISOString() }).eq("id", u.id);
    await admin.from("portal_audit").insert({ actor: me.email, action: "upload", detail: { receipt } });
  }
  after(() => processUpload(admin, u.id).catch(() => undefined)); // the hourly job retries anything left over
  return { ok: true as const };
}

/** Staff only: look at the portal as one clerk sees it, or stop. */
export async function viewAs(fd: FormData) {
  const { cookies } = await import("next/headers");
  const { requireProfile } = await import("@/lib/auth");
  const { redirect } = await import("next/navigation");
  await requireProfile();
  const id = String(fd.get("clerk") ?? "");
  const jar = await cookies();
  if (id) jar.set("portal_as", id, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 3600 });
  else jar.delete("portal_as");
  redirect(id ? "/portal" : "/clerk-portal?tab=people");
}
