"use server";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getLists, saveLists, emailsIn, LIST_LABEL, type ListName, type Lists } from "@/lib/distribution";
import { writeProjectsTab } from "@/lib/portal/projects-writer";

/** Email list changes, by anyone on the team; each one is copied into the diary's Projects tab as soon as it's free. */
const isList = (k: string): k is ListName => k in LIST_LABEL;
const copyToDiary = () => after(() => writeProjectsTab(createServiceClient()).catch(() => undefined)); // the 15-minute job retries

export async function removeFromList(projectId: string, list: string, email: string) {
  const me = await requireProfile();
  if (!isList(list)) return;
  const admin = createServiceClient();
  const { lists } = await getLists(admin, projectId);
  await saveLists(admin, projectId, { ...lists, [list]: lists[list].filter((e) => e.toLowerCase() !== email.toLowerCase()) }, me.full_name ?? me.email);
  copyToDiary();
  revalidatePath(`/projects/${projectId}`);
}

export async function addToList(projectId: string, list: string, form: FormData) {
  const me = await requireProfile();
  if (!isList(list)) return;
  const add = emailsIn(form.get("emails"));
  if (!add.length) return;
  const admin = createServiceClient();
  const { lists } = await getLists(admin, projectId);
  await saveLists(admin, projectId, { ...lists, [list]: [...lists[list], ...add.filter((a) => !lists[list].some((e) => e.toLowerCase() === a.toLowerCase()))] }, me.full_name ?? me.email);
  copyToDiary();
  revalidatePath(`/projects/${projectId}`);
}

/** Someone has left: take them off the ticked projects' lists, putting their replacement in the same place if given. */
export async function replaceEverywhere(form: FormData) {
  const me = await requireProfile();
  const old = emailsIn(form.get("old"))[0];
  const replacement = emailsIn(form.get("new"))[0] ?? null;
  const ids = form.getAll("project").map(String);
  if (!old || !ids.length) redirect(`/projects/lists?q=${encodeURIComponent(String(form.get("old") ?? ""))}&error=${encodeURIComponent("Tick at least one project")}`);
  const admin = createServiceClient();
  let n = 0;
  for (const id of ids) {
    const { lists } = await getLists(admin, id);
    const next = { ...lists } as Lists;
    for (const k of Object.keys(LIST_LABEL) as ListName[]) {
      if (!lists[k].some((e) => e.toLowerCase() === old.toLowerCase())) continue;
      const without = lists[k].filter((e) => e.toLowerCase() !== old.toLowerCase());
      next[k] = replacement && !without.some((e) => e.toLowerCase() === replacement.toLowerCase()) ? [...without, replacement] : without;
    }
    const why = replacement ? `${old} replaced by ${replacement}` : `${old} taken off`;
    try { if ((await saveLists(admin, id, next, me.full_name ?? me.email, why)).length) n++; } catch { /* e.g. it would leave nobody on the report list: skipped */ }
  }
  copyToDiary();
  revalidatePath("/projects/lists");
  redirect(`/projects/lists?q=${encodeURIComponent(replacement ?? old)}&done=${n}`);
}
