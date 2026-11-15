import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Each team member's own Gmail, used for one thing only: sending a checked report when they click "Approve and send"
 * (Ronan, 15 Nov 2026 - the second exception to "the dashboard never sends", after the new-clerk welcome email).
 * Only the "send email" permission is asked for: the dashboard can't read their mailbox.
 */
const SEND_SCOPE = "openid email https://www.googleapis.com/auth/gmail.send";

export function userAuthorizeUrl(redirectUri: string, state: string, email: string) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "", redirect_uri: redirectUri, response_type: "code", scope: SEND_SCOPE,
    access_type: "offline", prompt: "consent", hd: "beamore.co.uk", login_hint: email, state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function token(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", ...body }), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Google sign-in failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number; id_token?: string; scope?: string }>;
}

export async function connectUserGoogle(admin: SupabaseClient, profileId: string, code: string, redirectUri: string) {
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!t.refresh_token) throw new Error("Google didn't give a lasting permission; remove the dashboard's access in your Google account and try again");
  if (!/gmail\.send/.test(t.scope ?? "")) throw new Error("Permission to send email wasn't given");
  const email = t.id_token ? JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email : null;
  if (!email || !/@beamore\.co\.uk$/i.test(email)) throw new Error("Please use your @beamore.co.uk Google account");
  const { error } = await admin.from("user_google").upsert({
    profile_id: profileId, email, refresh_token: t.refresh_token, access_token: t.access_token,
    access_expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(), connected_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return email as string;
}

export async function userConnection(admin: SupabaseClient, profileId: string) {
  const { data } = await admin.from("user_google").select("email,connected_at").eq("profile_id", profileId).maybeSingle();
  return data as { email: string; connected_at: string } | null;
}

async function accessFor(admin: SupabaseClient, profileId: string) {
  const { data: c } = await admin.from("user_google").select("*").eq("profile_id", profileId).maybeSingle();
  if (!c) throw new Error("Connect your email first (Reports → Settings)");
  if (c.access_token && c.access_expires_at && new Date(c.access_expires_at) > new Date()) return { access: c.access_token as string, email: c.email as string };
  const t = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token });
  await admin.from("user_google").update({ access_token: t.access_token, access_expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString() }).eq("profile_id", profileId);
  return { access: t.access_token, email: c.email as string };
}

const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`);

/**
 * Sends one email from this team member's own Gmail: a checked report (PDF attached) to the client's list, or the
 * note about a report to its clerk (no attachment). Only ever on their click (Ronan, 15 Nov 2026).
 */
export async function sendReportEmail(admin: SupabaseClient, profileId: string, m: { to: string[]; cc: string[]; subject: string; body: string; fileName?: string; pdf?: Buffer }) {
  const { access, email } = await accessFor(admin, profileId);
  const b = `beamore${Date.now()}`;
  const CRLF = "\r\n";
  const wrap = (s: string) => s.replace(/(.{76})/g, `$1${CRLF}`);
  const mime = [
    `From: ${email}`, `To: ${m.to.join(", ")}`, ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []), `Subject: ${enc(m.subject)}`,
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${b}"`, "",
    `--${b}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(Buffer.from(m.body).toString("base64")),
    ...(m.pdf && m.fileName ? [`--${b}`, `Content-Type: application/pdf; name="${m.fileName.replace(/"/g, "")}"`, `Content-Disposition: attachment; filename="${m.fileName.replace(/"/g, "")}"`, "Content-Transfer-Encoding: base64", "", wrap(m.pdf.toString("base64"))] : []),
    `--${b}--`, "",
  ].join(CRLF);
  const res = await fetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", {
    method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "message/rfc822" }, body: mime, cache: "no-store",
  });
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { id: ((await res.json()) as { id: string }).id, from: email };
}
