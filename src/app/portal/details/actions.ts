"use server";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";

const v = (f: FormData, k: string) => { const x = String(f.get(k) ?? "").trim(); return x ? x.slice(0, 500) : null; };

/** The clerk's own details (first sign-in, and any time after). Saved to their record; ticks the onboarding steps. */
export async function saveDetails(form: FormData) {
  const me = await requirePortalUser();
  if (!me.clerk || me.viewingAs) redirect("/portal");
  const admin = createServiceClient();
  const bt = v(form, "business_type");
  await admin.from("clerks").update({ phone: v(form, "phone") }).eq("id", me.clerk.id);
  await admin.from("clerk_compliance").upsert({ clerk_id: me.clerk.id }, { onConflict: "clerk_id", ignoreDuplicates: true });
  const rel = v(form, "kin_relationship");
  const kin = [v(form, "kin_name"), rel ? `(${rel})` : null, v(form, "kin_phone")].filter(Boolean).join(" ");
  await admin.from("clerk_compliance").update({
    address: v(form, "address"),
    next_of_kin_name: v(form, "kin_name"), next_of_kin_relationship: rel, next_of_kin_phone: v(form, "kin_phone"),
    emergency_contact: kin || null,
    business_type: bt && ["limited", "sole_trader", "umbrella"].includes(bt) ? bt : null, company_name: v(form, "company_name"),
    dbs_level: v(form, "dbs_level"), dbs_checked: v(form, "dbs_checked"), dbs_update_service: form.get("dbs_update_service") === "on",
    ppe_notes: v(form, "ppe_sizes"),
    details_completed_at: new Date().toISOString(), join_submitted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq("clerk_id", me.clerk.id);
  await admin.from("portal_audit").insert({ actor: me.email, action: "details-saved", detail: { clerk: me.clerk.id } });
  redirect("/portal?saved=1");
}
