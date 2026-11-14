import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { setDfe } from "../actions";

export const dynamic = "force-dynamic";

const STAGE: Record<string, string> = {
  enquiry: "Enquiry", pricing: "Pricing", sent: "Sent", won_arranging: "Won", won_preparing: "Won", live: "Live", on_hold: "On hold",
};

/** Quick review of the automatic DfE decisions: one click per project, questions first. */
export default async function DfeReview() {
  await requireProfile();
  const db = await createClient();
  const { data } = await db.from("projects").select("id,display_name,stage,is_dfe,dfe_evidence,clients(name)")
    .in("stage", Object.keys(STAGE)).order("name");
  const all = data ?? [];
  const confirmed = (p: (typeof all)[number]) => p.dfe_evidence?.startsWith("Set by");
  const unsure = all.filter((p) => p.is_dfe == null);
  const autoDfe = all.filter((p) => p.is_dfe === true && !confirmed(p));
  const autoOther = all.filter((p) => p.is_dfe === false && !confirmed(p));
  const done = all.filter(confirmed);

  const Row = ({ p }: { p: (typeof all)[number] }) => (
    <tr>
      <td><Link href={`/projects/${p.id}`}>{p.display_name}</Link>
        <span className="two">{STAGE[p.stage]}{(p.clients as unknown as { name: string } | null)?.name ? ` · ${(p.clients as unknown as { name: string }).name}` : ""}</span></td>
      <td className="small muted">{(p.dfe_evidence ?? "Not checked yet").replace(/^Unsure: /, "")}</td>
      <td className="dfe-btns">
        <form action={setDfe.bind(null, p.id, true)}><button className={`btn ${p.is_dfe === true ? "primary" : ""}`}>DfE</button></form>
        <form action={setDfe.bind(null, p.id, false)}><button className={`btn ${p.is_dfe === false ? "primary" : ""}`}>Other</button></form>
      </td>
    </tr>
  );
  const Table = ({ title, rows, note }: { title: string; rows: typeof all; note: string }) => rows.length ? (
    <section className="panel" style={{ marginBottom: 16 }}>
      <h2>{title} <span className="muted small">{rows.length}</span></h2>
      <p className="small muted">{note}</p>
      <table className="dfe-table"><tbody>{rows.map((p) => <Row key={p.id} p={p} />)}</tbody></table>
    </section>
  ) : null;

  return (
    <>
      <Link href="/projects" className="small">← Projects</Link>
      <div className="head"><div>
        <h1>DfE or other</h1>
        <p>Click DfE or Other for each project. Once you click, the project moves to the bottom and the automation won’t change it. The highlighted button is the current answer.</p>
      </div></div>
      <Table title="Not sure" rows={unsure} note="The dashboard couldn't tell. These need your answer." />
      <Table title="Marked DfE by the dashboard" rows={autoDfe} note="Check the reason; click Other if it's wrong." />
      <Table title="Marked Other by the dashboard" rows={autoOther} note="No DfE signs found. Click DfE if it is one." />
      <Table title="Confirmed by you" rows={done} note="Already answered. You can still change them." />
    </>
  );
}
