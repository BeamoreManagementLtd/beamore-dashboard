"use server";
import { redirect } from "next/navigation";
import { requireDirector } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncXero } from "@/lib/sync/xero-sync";
import { syncDiary } from "@/lib/sync/diary-sync";

export async function syncNow() {
  await requireDirector();
  const r = await syncXero(createServiceClient());
  redirect(r.ok ? "/finance?xero=synced" : `/finance?xero=error&reason=${encodeURIComponent(r.message)}`);
}

export async function syncDiaryNow() {
  await requireDirector();
  const r = await syncDiary(createServiceClient(), { force: true });
  redirect(r.ok ? "/finance?diary=synced" : `/finance?diary=error&reason=${encodeURIComponent(r.message)}`);
}
