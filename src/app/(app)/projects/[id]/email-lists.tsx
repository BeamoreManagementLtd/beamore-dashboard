import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getLists, LIST_LABEL, type ListName } from "@/lib/distribution";
import { removeFromList, addToList } from "../lists-actions";
import { setProjectChecker } from "../../reports/actions";

/** Who this project's reports and invoices go to: take people off or add them; the diary's Projects tab follows. */
export async function EmailLists({ db, projectId }: { db: SupabaseClient; projectId: string }) {
  const { lists, invoiceFromClient, invoiceNotes, pending } = await getLists(db, projectId);
  const [{ data: proj }, { data: staff }] = await Promise.all([
    db.from("projects").select("report_checker_id").eq("id", projectId).single(),
    db.from("profiles").select("id,full_name,email").order("full_name"),
  ]);
  const checker = proj?.report_checker_id as string | null;
  return (
    <section className="panel">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2>Email lists</h2>
        <Link className="small" href="/projects/lists">Someone has left? Replace them on every project</Link>
      </div>
      <table><tbody>
        {(Object.keys(LIST_LABEL) as ListName[]).map((k) => (
          <tr key={k}>
            <td className="muted small" style={{ width: 120, verticalAlign: "top", paddingTop: 10 }}>{LIST_LABEL[k]}</td>
            <td>
              <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                {lists[k].map((e) => (
                  <form key={e} action={removeFromList.bind(null, projectId, k, e)} className="chip">
                    <span>{e}</span>
                    <button className="chip-x" title={`Take ${e} off`} aria-label={`Take ${e} off ${LIST_LABEL[k]}`}>✕</button>
                  </form>
                ))}
                {!lists[k].length && <span className="muted small">Nobody</span>}
              </div>
              <form action={addToList.bind(null, projectId, k)} className="row" style={{ gap: 6, marginTop: 6 }}>
                <input name="emails" placeholder="Add email address(es)" style={{ maxWidth: 320 }} />
                <button className="btn small">Add</button>
              </form>
            </td>
          </tr>
        ))}
      </tbody></table>
      <form action={setProjectChecker.bind(null, projectId)} className="row" style={{ gap: 6, alignItems: "center", marginTop: 8 }}>
        <label className="small muted" htmlFor="rc">Reports checked by</label>
        <select id="rc" name="checker" defaultValue={checker ?? ""}><option value="">Nobody yet</option>{(staff ?? []).map((s) => <option key={s.id} value={s.id}>{s.full_name ?? s.email}</option>)}</select>
        <button className="btn small">Save</button>
      </form>
      {invoiceFromClient && <p className="small muted">The invoice lists are the client&apos;s usual ones. Changing them here gives this project its own.</p>}
      {invoiceNotes && <p className="small muted">Invoicing instructions: {invoiceNotes}</p>}
      <p className="small muted">{pending ? "Saved. It's copied into the diary's Projects tab as soon as nobody has had the diary open for 10 minutes." : "Changes are saved straight away and copied into the diary's Projects tab."}</p>
    </section>
  );
}
