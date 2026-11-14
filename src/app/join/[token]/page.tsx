import { createServiceClient } from "@/lib/supabase/server";
import { PPE_ITEMS } from "@/lib/clerk-join";
import { submitJoin } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Welcome to Beamore", robots: { index: false, follow: false } };

/** The new clerk questionnaire: no login, the link itself is the key (it belongs to one clerk). */
export default async function Join({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string; failed?: string }> }) {
  const { token } = await params;
  const { done, failed } = await searchParams;
  const admin = createServiceClient();
  const { data: c } = token.length >= 20
    ? await admin.from("clerk_compliance").select("*,clerks(name,email,phone)").eq("join_token", token).maybeSingle()
    : { data: null };
  const clerk = c?.clerks as unknown as { name: string; email: string | null; phone: string | null } | undefined;

  const shell = (inner: React.ReactNode) => (
    <main className="login join">
      <div className="login-card join-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <div className="brand"><img src="/beamore-logo.jpg" alt="Beamore" /><span><b>Beamore</b><small>Management</small></span></div>
        {inner}
      </div>
    </main>
  );
  if (!c || !clerk) return shell(<><h1>Link not recognised</h1><p className="muted">This link has expired or was copied wrongly. Please ask Beamore for a new one.</p></>);
  if (done) return shell(<>
    <h1>Thank you, {clerk.name.split(" ")[0]}</h1>
    <p>Your details are with us. Judy or Anél will be in touch if anything else is needed.</p>
    {failed && <p className="callout warn">These didn’t upload: {failed}. Please email them to us instead.</p>}
    <p className="small muted">You can open this link again to correct anything.</p>
  </>);

  const v = (k: string) => (c[k] as string | null) ?? "";
  return shell(
    <form action={submitJoin.bind(null, token)} className="form join-form">
      <h1>Welcome to Beamore, {clerk.name.split(" ")[0]}</h1>
      <p className="muted">Please fill in what you can. It takes about five minutes. Your answers go straight to the Beamore office.</p>

      <h2>Your details</h2>
      <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required defaultValue={clerk.email ?? ""} /></div>
      <div className="field"><label htmlFor="phone">Mobile</label><input id="phone" name="phone" required defaultValue={clerk.phone ?? ""} /></div>
      <div className="field"><label htmlFor="address">Home address</label><textarea id="address" name="address" rows={2} required defaultValue={v("address")} /></div>
      <div className="field"><label htmlFor="ec">Emergency contact (name and phone)</label><input id="ec" name="emergency_contact" required defaultValue={v("emergency_contact")} /></div>
      <div className="field"><label htmlFor="bt">You work as</label>
        <select id="bt" name="business_type" required defaultValue={v("business_type")}>
          <option value="" disabled>Choose…</option><option value="limited">A limited company</option><option value="sole_trader">A sole trader</option><option value="umbrella">Through an umbrella company</option>
        </select></div>
      <div className="field"><label htmlFor="co">Company name (if any)</label><input id="co" name="company_name" defaultValue={v("company_name")} /></div>
      <p className="small muted">Please send bank details separately by phone or email, not on this form.</p>

      <h2>Insurance</h2>
      <div className="row">
        <div className="field"><label htmlFor="pi">Professional indemnity expires</label><input id="pi" name="pi_insurance_expiry" type="date" defaultValue={v("pi_insurance_expiry")} /></div>
        <div className="field"><label htmlFor="pif">Certificate</label><input id="pif" name="pi_file" type="file" accept=".pdf,image/*" /></div>
      </div>
      <div className="row">
        <div className="field"><label htmlFor="pl">Public liability expires</label><input id="pl" name="pl_insurance_expiry" type="date" defaultValue={v("pl_insurance_expiry")} /></div>
        <div className="field"><label htmlFor="plf">Certificate</label><input id="plf" name="pl_file" type="file" accept=".pdf,image/*" /></div>
      </div>

      <h2>DBS</h2>
      <div className="row">
        <div className="field"><label htmlFor="dl">Level</label>
          <select id="dl" name="dbs_level" defaultValue={v("dbs_level")}><option value="">—</option><option>Basic</option><option>Standard</option><option>Enhanced</option></select></div>
        <div className="field"><label htmlFor="dc">Date issued</label><input id="dc" name="dbs_checked" type="date" defaultValue={v("dbs_checked")} /></div>
      </div>
      <div className="field"><label htmlFor="dus"><input id="dus" name="dbs_update_service" type="checkbox" defaultChecked={!!c.dbs_update_service} style={{ width: "auto", marginRight: 6 }} />I’m on the DBS Update Service</label></div>
      <div className="field"><label htmlFor="dbsf">DBS certificate</label><input id="dbsf" name="dbs_file" type="file" accept=".pdf,image/*" /></div>

      <h2>CSCS card</h2>
      <div className="row">
        <div className="field"><label htmlFor="cn">Card number</label><input id="cn" name="cscs_number" defaultValue={v("cscs_number")} /></div>
        <div className="field"><label htmlFor="ce">Expires</label><input id="ce" name="cscs_expiry" type="date" defaultValue={v("cscs_expiry")} /></div>
      </div>
      <div className="field"><label htmlFor="cf">Photo of the card</label><input id="cf" name="cscs_file" type="file" accept=".pdf,image/*" /></div>

      <h2>Qualifications</h2>
      <div className="row">
        <div className="field"><label htmlFor="cb">Professional body (if any)</label><input id="cb" name="chartership_body" placeholder="ICWCI, CIOB, RICS…" defaultValue={v("chartership_body")} /></div>
        <div className="field"><label htmlFor="cg">Grade</label><input id="cg" name="chartership_grade" placeholder="e.g. MICWCI" defaultValue={v("chartership_grade")} /></div>
        <div className="field"><label htmlFor="cnum">Membership number</label><input id="cnum" name="chartership_number" defaultValue={v("chartership_number")} /></div>
      </div>
      <div className="field"><label htmlFor="qf">Certificate</label><input id="qf" name="qual_file" type="file" accept=".pdf,image/*" /></div>

      <h2>PPE</h2>
      <p className="small muted">Beamore provides a helmet and a vest. Tick any you already have from us.</p>
      <div className="join-ppe">
        {PPE_ITEMS.map((i) => (
          <label key={i}><input type="checkbox" name={`ppe_${i}`} defaultChecked={((c.ppe_have as string[]) ?? []).includes(i)} /> {i}</label>
        ))}
      </div>
      <div className="field"><label htmlFor="ps">Vest size</label><input id="ps" name="ppe_sizes" defaultValue={v("ppe_notes")} /></div>

      <p className="small muted">Files up to about 4 MB in total. If yours are bigger, email them to us instead.</p>
      <button className="btn primary">Send to Beamore</button>
    </form>
  );
}
