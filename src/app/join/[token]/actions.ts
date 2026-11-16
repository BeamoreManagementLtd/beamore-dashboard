"use server";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { clerkFolder, uploadToFolder, PPE_ITEMS } from "@/lib/clerk-join";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim().slice(0, 300) || null;
const date = (f: FormData, k: string) => { const v = s(f, k); return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; };
const DOCS: [string, string][] = [
  ["pi_file", "Professional indemnity insurance"], ["pl_file", "Public liability insurance"],
  ["dbs_file", "DBS certificate"], ["cscs_file", "CSCS card"], ["qual_file", "Qualifications"],
];

/** The clerk's own answers. Only the fields on the form, only for the clerk the token belongs to. */
export async function submitJoin(token: string, form: FormData) {
  const admin = createServiceClient();
  const { data: c } = await admin.from("clerk_compliance").select("clerk_id,clerks(name)").eq("join_token", token).maybeSingle();
  if (!c) redirect("/join/invalid");
  const name = (c.clerks as unknown as { name: string } | null)?.name ?? "Clerk";
  const bt = s(form, "business_type");
  await admin.from("clerks").update({ email: s(form, "email"), phone: s(form, "phone") }).eq("id", c.clerk_id);
  await admin.from("clerk_compliance").update({
    address: s(form, "address"), emergency_contact: s(form, "emergency_contact"),
    business_type: bt && ["limited", "sole_trader", "umbrella"].includes(bt) ? bt : null, company_name: s(form, "company_name"),
    pi_insurance_expiry: date(form, "pi_insurance_expiry"), pl_insurance_expiry: date(form, "pl_insurance_expiry"),
    cscs_number: s(form, "cscs_number"), cscs_expiry: date(form, "cscs_expiry"),
    dbs_level: s(form, "dbs_level"), dbs_checked: date(form, "dbs_checked"), dbs_update_service: form.get("dbs_update_service") === "on",
    chartership_body: s(form, "chartership_body"), chartership_grade: s(form, "chartership_grade"), chartership_number: s(form, "chartership_number"),
    ppe_have: PPE_ITEMS.filter((i) => form.get(`ppe_${i}`) === "on"), ppe_notes: s(form, "ppe_sizes"),
    join_submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("clerk_id", c.clerk_id);

  // certificates into their Personnel folder; a failure here doesn't lose the answers above
  const saved: string[] = [], failed: string[] = [];
  const files = DOCS.map(([k, label]) => [form.get(k), label] as const).filter(([f]) => f instanceof File && f.size > 0) as [File, string][];
  if (files.length) {
    try {
      const folder = await clerkFolder(admin, c.clerk_id, name);
      for (const [f, label] of files) { try { saved.push(await uploadToFolder(admin, folder, f, label)); } catch { failed.push(label); } }
    } catch { failed.push(...files.map(([, l]) => l)); }
  }
  // new clerks' paperwork is Ronan's (16 Nov 2026); it can be moved to someone else on the due list
  const { data: ronan } = await admin.from("profiles").select("id").eq("role", "director").limit(1);
  await admin.from("tasks").insert({ owner_id: ronan?.[0]?.id ?? null, owner_name: ronan?.[0]?.id ? null : "Ronan", title: `Check ${name}'s new clerk form`, kind: "Personnel", link: `/personnel/${c.clerk_id}`, due: new Date().toISOString().slice(0, 10) });
  redirect(`/join/${token}?done=1${failed.length ? `&failed=${encodeURIComponent(failed.join(", "))}` : ""}`);
}
