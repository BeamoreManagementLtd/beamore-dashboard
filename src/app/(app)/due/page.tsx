import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { staffPeople } from "@/lib/staff";
import { buildDueList, isMine, type DueItem } from "@/lib/due";
import { fd } from "@/lib/format";
import { addTask, completeTask, moveDueItem } from "./actions";

export const dynamic = "force-dynamic";

export default async function Due({ searchParams }: { searchParams: Promise<{ who?: string }> }) {
  const me = await requireProfile();
  const { who = "all" } = await searchParams;
  const db = await createClient();
  const [items, people] = await Promise.all([buildDueList(db, me), staffPeople(createServiceClient())]);
  const t = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
  const shown = who === "mine" ? items.filter((i) => isMine(i, me)) : items;
  const groups = new Map<string, DueItem[]>();
  for (const i of shown) groups.set(i.owner ?? "Unassigned", [...(groups.get(i.owner ?? "Unassigned") ?? []), i]);
  const late = shown.filter((i) => i.due && i.due < t).length;
  const joint = `${people.find((p) => p.role === "director")?.first ?? "Ronan"} or Judy`;

  return (
    <>
      <div className="head">
        <div><h1>Due list</h1><p>{shown.length} things to do{late ? `, ${late} overdue` : ""}. Most items clear themselves once the job is done. Use Move to give one to someone else.</p></div>
      </div>
      <nav className="row">
        <a href="/due" className={`btn ${who !== "mine" ? "primary" : ""}`}>Everyone</a>
        <a href="/due?who=mine" className={`btn ${who === "mine" ? "primary" : ""}`}>Mine</a>
      </nav>
      <section className="panel">
        <h2>Add a task</h2>
        <form action={addTask} className="row">
          <div className="field" style={{ flex: "3 1 260px" }}><label htmlFor="t">What needs doing</label><input id="t" name="title" required placeholder="e.g. Send Connaught site contacts to the new clerk" /></div>
          <div className="field"><label htmlFor="d">Due</label><input id="d" name="due" type="date" /></div>
          <div className="field"><label htmlFor="o">For</label>
            <select id="o" name="owner_id" defaultValue="">
              <option value="">Me</option>
              {people.filter((p) => p.email !== me.email).map((p) => <option key={p.email} value={p.profileId ?? `name:${p.first}`}>{p.name}</option>)}
              <option value="none">Anyone</option>
            </select>
          </div>
          <button className="btn primary">Add</button>
        </form>
      </section>
      {!shown.length && <p className="empty">Nothing due.</p>}
      {[...groups].map(([owner, list]) => (
        <section className="panel" key={owner}>
          <h2>{owner} <span className="small muted">{list.length}</span></h2>
          <table><tbody>
            {list.map((i) => (
              <tr key={i.key}>
                <td style={{ width: 90 }}><span className="pill neutral">{i.kind}</span></td>
                <td>{i.link ? <Link href={i.link}><b>{i.title}</b></Link> : <b>{i.title}</b>}{i.detail && <span className="two">{i.detail}</span>}</td>
                <td className={`num ${i.due && i.due < t ? "neg" : ""}`}>{i.due ? (i.due < t ? `${fd(i.due)} · overdue` : i.due === t ? "Today" : fd(i.due)) : "—"}</td>
                <td style={{ width: 210 }}>
                  {/* move it to someone else's list, or make it a joint job */}
                  <form action={moveDueItem.bind(null, i.key, i.taskId ?? null)} className="row" style={{ gap: 4, flexWrap: "nowrap" }}>
                    <select name="to" aria-label="Move to" defaultValue="" style={{ maxWidth: 140 }}>
                      <option value="" disabled>Move to…</option>
                      {people.map((p) => <option key={p.email} value={p.profileId ?? `name:${p.first}`}>{p.first}</option>)}
                      <option value="joint">{joint}</option>
                    </select>
                    <button className="btn small">Move</button>
                  </form>
                </td>
                <td className="num" style={{ width: 70 }}>
                  {i.taskId && <form action={completeTask.bind(null, i.taskId)}><button className="btn">Done</button></form>}
                </td>
              </tr>
            ))}
          </tbody></table>
        </section>
      ))}
    </>
  );
}
