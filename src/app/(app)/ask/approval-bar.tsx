import { createClient } from "@/lib/supabase/server";
import { approveRequest, denyRequest } from "./actions";

const KIND: Record<string, string> = { off_topic: "Not Beamore work", action: "Needs your OK", over_limit: "Over today's limit" };

/** Ronan's pop-up: anything staff asked the assistant that needs his permission. Shown on every dashboard page. */
export async function ApprovalBar() {
  const db = await createClient();
  const { data } = await db.from("ai_requests").select("id,at,requester_name,kind,summary,question").eq("status", "pending").order("at").limit(5);
  if (!data?.length) return null;
  return (
    <div className="approvals" role="alert">
      <b>{data.length === 1 ? "1 request needs your OK" : `${data.length} requests need your OK`}</b>
      {data.map((r) => (
        <div key={r.id} className="approval">
          <div>
            <span className="pill warn">{KIND[r.kind] ?? r.kind}</span> <b>{r.requester_name}</b>: {r.summary}
            {r.question && r.question !== r.summary && <div className="small muted">&ldquo;{r.question.slice(0, 220)}&rdquo;</div>}
          </div>
          <div className="approval-btns">
            <form action={approveRequest}><input type="hidden" name="id" value={r.id} /><button className="btn primary">Approve</button></form>
            <form action={denyRequest}><input type="hidden" name="id" value={r.id} /><button className="btn">Deny</button></form>
          </div>
        </div>
      ))}
    </div>
  );
}
