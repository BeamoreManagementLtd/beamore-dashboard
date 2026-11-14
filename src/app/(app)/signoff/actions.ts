"use server";
import { redirect } from "next/navigation";
import { requireDirector } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { prepareDrafts, createDrafts, monthStart } from "@/lib/signoff";

const ok = (m: string) => /^\d{4}-\d{2}-01$/.test(m);

export async function prepare(m: string) {
  await requireDirector();
  if (!ok(m)) throw new Error("Bad month");
  let q: string;
  try {
    const r = await prepareDrafts(createServiceClient(), m);
    q = `done=prepared&n=${r.prepared}&s=${r.skipped}`;
  } catch (e) {
    q = `error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`;
  }
  redirect(`/signoff?month=${monthStart(m).slice(0, 7)}&${q}`);
}

/** Rebuilds an already-invoiced month's drafts from the month before and compares them with what was invoiced. */
export async function check(m: string) {
  await requireDirector();
  if (!ok(m)) throw new Error("Bad month");
  let q: string;
  try {
    const r = await prepareDrafts(createServiceClient(), m, { test: true });
    q = `done=checked&n=${r.matched}&s=${r.compared}`;
  } catch (e) {
    q = `error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`;
  }
  redirect(`/signoff?month=${m.slice(0, 7)}&${q}`);
}

export async function approve(m: string) {
  const me = await requireDirector();
  if (!ok(m)) throw new Error("Bad month");
  let q: string;
  try {
    const r = await createDrafts(createServiceClient(), m, me.id);
    q = `done=created&n=${r.created}&f=${r.failed}`;
  } catch (e) {
    q = `error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`;
  }
  redirect(`/signoff?month=${m.slice(0, 7)}&${q}`);
}
