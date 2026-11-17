import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";

type Header = { name: string; value: string };
type Msg = { id: string; threadId: string; internalDate: string; snippet?: string; labelIds?: string[]; payload?: { headers?: Header[] } };

const header = (m: Msg, n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const displayName = (from: string) => (/^"?([^"<]+?)"?\s*</.exec(from)?.[1] ?? from).trim();

/**
 * For every outstanding invoice, finds Gmail threads that mention its number and adds each new message to the invoice's
 * timeline. If the newest email in the chase is from the client and we were waiting on them, the chase moves to
 * "We owe a reply". Reads only; never sends or changes email.
 */
export async function syncGmail(admin: SupabaseClient) {
  // one run at a time: two together trip Gmail's per-minute limit
  const { data: running } = await admin.from("sync_runs").select("id").eq("source", "gmail").is("finished_at", null)
    .gte("started_at", new Date(Date.now() - 6 * 60000).toISOString()).limit(1);
  if (running?.length) return { ok: true, message: "A Gmail read is already running; it will finish on its own." };
  const { data: run } = await admin.from("sync_runs").insert({ source: "gmail" }).select("id").single();
  const finish = (ok: boolean, message: string) =>
    admin.from("sync_runs").update({ finished_at: new Date().toISOString(), ok, message }).eq("id", run?.id);
  try {
    const g = await driveClient(admin);
    const { data: invoices } = await admin.from("invoices").select("id,number,issued").gt("amount_due", 0);
    const { data: existing } = await admin.from("chase_events").select("invoice_id,gmail_message_id,gmail_thread_id,happened_at").eq("source", "gmail");
    const have = new Set((existing ?? []).filter((e) => e.gmail_message_id).map((e) => `${e.invoice_id}|${e.gmail_message_id}`));
    // threads already summarised by hand in the first import: only take messages newer than the last summary
    const summarisedUntil = new Map<string, string>();
    for (const e of existing ?? [])
      if (!e.gmail_message_id && e.gmail_thread_id && (summarisedUntil.get(e.gmail_thread_id) ?? "") < e.happened_at) summarisedUntil.set(e.gmail_thread_id, e.happened_at);

    let added = 0, moved = 0, searched = 0;
    const list = invoices ?? [];
    for (let i = 0; i < list.length; i += 3) { // gently: new Google projects have low per-minute limits
      await Promise.all(list.slice(i, i + 3).map(async (inv) => {
        searched++;
        const after = (inv.issued ?? "2026-01-01").replace(/-/g, "/");
        const res = await g.gmail<{ threads?: { id: string }[] }>("threads", { q: `"${inv.number}" after:${after}`, maxResults: "10" });
        const rows: Record<string, unknown>[] = [];
        let lastIn = "", lastOut = "";
        for (const t of res.threads ?? []) {
          const thread = await g.gmail<{ messages: Msg[] }>(`threads/${t.id}`, { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
          for (const m of thread.messages ?? []) {
            const when = new Date(Number(m.internalDate)).toISOString();
            const from = header(m, "From");
            const ours = /@beamore\.co\.uk/i.test(from) || (m.labelIds ?? []).includes("SENT");
            const viaXero = /xero/i.test(from);
            const text = `${from} ${header(m, "Subject")} ${m.snippet ?? ""}`;
            const bounced = !ours && /mailer-daemon|mail delivery|delivery status notification|undeliverable|address not found/i.test(text);
            // automatic acknowledgements and out-of-office replies don't need an answer
            const automatic = !ours && !bounced && /no-?reply|do-?not-?reply|invoice has been received|has been received and|automatic reply|auto-?reply|out of (the )?office/i.test(text);
            if (!viaXero && !automatic && !bounced) { if (ours) lastOut = when > lastOut ? when : lastOut; else lastIn = when > lastIn ? when : lastIn; }
            if (have.has(`${inv.id}|${m.id}`)) continue;
            if ((summarisedUntil.get(t.id) ?? "") >= when) continue;
            have.add(`${inv.id}|${m.id}`);
            rows.push({
              invoice_id: inv.id, happened_at: when, source: "gmail",
              kind: viaXero ? "Invoice emailed (Xero)" : ours ? "Email sent" : bounced ? "Email bounced" : automatic ? "Auto-acknowledgement" : "Email received",
              who: displayName(from), body: `${header(m, "Subject")}${m.snippet ? ` — ${decode(m.snippet).slice(0, 220)}` : ""}`,
              gmail_thread_id: t.id, gmail_message_id: m.id,
            });
          }
        }
        if (rows.length) {
          const { error } = await admin.from("chase_events").insert(rows);
          if (error?.code === "23505") {
            // another run added some of these already: insert one by one and skip the duplicates
            for (const r of rows) if (!(await admin.from("chase_events").insert(r)).error) added++;
          } else if (error) throw new Error(`${inv.number}: ${error.message}`);
          else added += rows.length;
        }
        // client wrote last, after the chase was last updated, and we were waiting on them → our move
        if (lastIn && lastIn > lastOut) {
          const { data: cs } = await admin.from("chase_state").select("status,updated_at").eq("invoice_id", inv.id).maybeSingle();
          if (!cs || ((cs.status === "new" || cs.status === "waiting") && lastIn > cs.updated_at)) {
            await admin.from("chase_state").upsert({ invoice_id: inv.id, status: "our_move", with_whom: "Beamore", updated_at: new Date().toISOString() });
            await admin.from("chase_events").insert({ invoice_id: inv.id, happened_at: new Date().toISOString(), source: "gmail", kind: "Status changed", who: "Dashboard", body: "Client replied: now our move" });
            moved++;
          }
        }
        // and back: we've replied since they wrote (Ronan, 17 Nov 2026: WSP-141 still said "ball in our court" after his reply)
        if (lastOut && lastOut > lastIn) {
          const { data: cs } = await admin.from("chase_state").select("status,updated_at").eq("invoice_id", inv.id).maybeSingle();
          if (cs?.status === "our_move") {
            await admin.from("chase_state").update({ status: "waiting", with_whom: "Client", updated_at: new Date().toISOString() }).eq("invoice_id", inv.id);
            await admin.from("chase_events").insert({ invoice_id: inv.id, happened_at: new Date().toISOString(), source: "gmail", kind: "Status changed", who: "Dashboard", body: "We replied: waiting on them" });
            moved++;
          }
        }
      }));
    }
    const msg = `${searched} outstanding invoices searched in Gmail, ${added} new emails added to timelines, ${moved} moved to "We owe a reply"`;
    await finish(true, msg);
    return { ok: true, message: msg };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const msg = / 403/.test(raw) && /insufficient|scope|permission/i.test(raw) && !/quota/i.test(raw)
      ? `Gmail access not granted yet: reconnect Google on the Finance page. (${raw.slice(0, 120)})` : raw;
    await finish(false, msg);
    return { ok: false, message: msg };
  }
}
