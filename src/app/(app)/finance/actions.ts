"use server";
import { redirect } from "next/navigation";
import { requireDirector } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { syncXero } from "@/lib/sync/xero-sync";

export async function syncNow() {
  await requireDirector();
  const r = await syncXero(createServiceClient());
  redirect(r.ok ? "/finance?xero=synced" : `/finance?xero=error&reason=${encodeURIComponent(r.message)}`);
}
