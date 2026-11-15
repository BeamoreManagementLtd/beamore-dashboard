import { createServiceClient } from "@/lib/supabase/server";
import { requirePortalUser } from "@/lib/portal/auth";
import { saveDetails } from "./actions";

export default async function Details() {
  const me = await requirePortalUser();
  if (!me.clerk) return <p className="muted">Clerks only.</p>;
  const db = createServiceClient();
  const [{ data: c }, { data: k }] = await Promise.all([
    db.from("clerks").select("phone").eq("id", me.clerk.id).single(),
    db.from("clerk_compliance").select("address,next_of_kin_name,next_of_kin_relationship,next_of_kin_phone,business_type,company_name,dbs_level,dbs_checked,dbs_update_service,ppe_notes,details_completed_at").eq("clerk_id", me.clerk.id).maybeSingle(),
  ]);
  const first = !k?.details_completed_at;
  return (
    <>
      <section className="portal-hello">
        <h1>{first ? "Welcome to Beamore" : "Your details"}</h1>
        <p className="muted">{first ? "Before anything else, please fill in your details. It only takes a couple of minutes, and you can change them here any time." : "Keep these up to date so we can reach you and your next of kin."}</p>
      </section>
      <form action={saveDetails} className="card form">
        <h2>You</h2>
        <div className="row">
          <div className="field"><label htmlFor="ph">Mobile number</label><input id="ph" name="phone" required defaultValue={c?.phone ?? ""} autoComplete="tel" /></div>
          <div className="field" style={{ flex: "2 1 320px" }}><label htmlFor="ad">Home address and postcode (for PPE deliveries)</label><textarea id="ad" name="address" rows={3} required defaultValue={k?.address ?? ""} autoComplete="street-address" /></div>
        </div>
        <h2>Next of kin</h2>
        <div className="row">
          <div className="field"><label htmlFor="kn">Name</label><input id="kn" name="kin_name" required defaultValue={k?.next_of_kin_name ?? ""} /></div>
          <div className="field"><label htmlFor="kr">Relationship</label><input id="kr" name="kin_relationship" placeholder="e.g. wife, son" defaultValue={k?.next_of_kin_relationship ?? ""} /></div>
          <div className="field"><label htmlFor="kp">Phone</label><input id="kp" name="kin_phone" required defaultValue={k?.next_of_kin_phone ?? ""} /></div>
        </div>
        <h2>How you invoice us</h2>
        <div className="row">
          <div className="field"><label htmlFor="bt">I work as</label>
            <select id="bt" name="business_type" defaultValue={k?.business_type ?? ""}><option value="">Choose…</option><option value="limited">A limited company</option><option value="sole_trader">A sole trader</option><option value="umbrella">Through an umbrella company</option></select></div>
          <div className="field"><label htmlFor="cn">Company name (if any)</label><input id="cn" name="company_name" defaultValue={k?.company_name ?? ""} /></div>
        </div>
        <p className="small muted">Bank details: please don&apos;t put them here. Send them with your first invoice and we&apos;ll set you up in our accounts system.</p>
        <h2>DBS</h2>
        <div className="row">
          <div className="field"><label htmlFor="dl">Level</label>
            <select id="dl" name="dbs_level" defaultValue={k?.dbs_level ?? ""}><option value="">None / not sure</option><option>Basic</option><option>Standard</option><option>Enhanced</option></select></div>
          <div className="field"><label htmlFor="dc">Date of certificate</label><input id="dc" name="dbs_checked" type="date" defaultValue={k?.dbs_checked ?? ""} /></div>
          <label className="small" style={{ alignSelf: "center" }}><input type="checkbox" name="dbs_update_service" defaultChecked={!!k?.dbs_update_service} /> I&apos;m on the DBS Update Service</label>
        </div>
        <h2>PPE</h2>
        <div className="field"><label htmlFor="pp">Your sizes (we send a Beamore helmet and vest)</label><input id="pp" name="ppe_sizes" placeholder="e.g. vest XL" defaultValue={k?.ppe_notes ?? ""} /></div>
        <p className="small muted">Insurance certificates, your CSCS card and qualifications go on the Insurance and Certificates pages.</p>
        <button className="btn primary" disabled={!!me.viewingAs}>{first ? "Save and continue" : "Save"}</button>
      </form>
    </>
  );
}
