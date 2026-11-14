"use server";
import { redirect } from "next/navigation";
import { requireDirector } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncXero } from "@/lib/sync/xero-sync";
import { syncDiary } from "@/lib/sync/diary-sync";
import { syncGmail } from "@/lib/sync/gmail-sync";
import { setupProjectTracking } from "@/lib/xero-tracking";

export async function syncNow() {
  await requireDirector();
  const r = await syncXero(createServiceClient());
  redirect(r.ok ? "/finance?xero=synced" : `/finance?xero=error&reason=${encodeURIComponent(r.message)}`);
}

/** Adds the "Project" tracking category and live projects' options in Xero. Only runs when the director clicks it. */
export async function setupTracking() {
  await requireDirector();
  const r = await setupProjectTracking(createServiceClient());
  redirect(r.ok ? "/finance?xero=tracking" : `/finance?xero=error&reason=${encodeURIComponent(r.message)}`);
}

export async function syncGmailNow() {
  await requireDirector();
  const r = await syncGmail(createServiceClient());
  redirect(r.ok ? "/finance?diary=gmail" : `/finance?diary=error&reason=${encodeURIComponent(r.message)}`);
}

export async function syncDiaryNow() {
  await requireDirector();
  const r = await syncDiary(createServiceClient(), { force: true });
  redirect(r.ok ? "/finance?diary=synced" : `/finance?diary=error&reason=${encodeURIComponent(r.message)}`);
}
