import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Drive: read everything (diary, reports, proposals) and create project folders inside the existing Work/Schools and
// Work/Others folders (which needs normal Drive access because the dashboard didn't make those folders). The code only
// ever creates folders and files; it never deletes, moves or trashes. Gmail: read (chases, replies) and compose, used
// only to save drafts in the Drafts folder. The dashboard never sends anything (Ronan's rule).
export const GOOGLE_SCOPES = process.env.GOOGLE_SCOPES ??
  "openid email https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/admin.directory.user";
/** Connections made before this can't create @beamore.co.uk accounts for new clerks (Admin SDK, 15 Nov 2026). */
export const GOOGLE_SCOPES_CHANGED_AT = "2026-11-15T17:00:00Z";

type Tokens = { access_token: string; refresh_token?: string; expires_in: number; id_token?: string };

function creds() {
  const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set");
  return { id, secret };
}

export function googleAuthorizeUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "", redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", hd: "beamore.co.uk", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function token(body: Record<string, string>): Promise<Tokens> {
  const { id, secret } = creds();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: secret, ...body }), cache: "no-store",
  });
  if (!res.ok) throw new Error(`Google token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function connectGoogle(admin: SupabaseClient, code: string, redirectUri: string, userId: string) {
  const t = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!t.refresh_token) throw new Error("Google did not return a refresh token; remove the app's access in your Google account and connect again");
  const email = t.id_token ? JSON.parse(Buffer.from(t.id_token.split(".")[1], "base64url").toString()).email : null;
  const { error } = await admin.from("google_connection").upsert({
    id: 1, email, refresh_token: t.refresh_token, access_token: t.access_token,
    access_expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    connected_by: userId, connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Saving the Google connection failed: ${error.message}`);
  return email as string | null;
}

/** Drive caller using the stored connection; refreshes the access token when it has expired. */
export async function driveClient(admin: SupabaseClient) {
  const { data: c, error } = await admin.from("google_connection").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) throw new Error("Google Drive is not connected yet (Finance → Connect Google Drive)");
  let access = c.access_token as string | null;
  if (!access || !c.access_expires_at || new Date(c.access_expires_at) < new Date()) {
    const t = await token({ grant_type: "refresh_token", refresh_token: c.refresh_token });
    access = t.access_token;
    await admin.from("google_connection").update({
      access_token: t.access_token, updated_at: new Date().toISOString(),
      access_expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    }).eq("id", 1);
  }
  const call = async (url: string) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
      if (res.ok) return res;
      const text = await res.text();
      // rate limits come back as 429, or 403 "Quota exceeded"/"rateLimitExceeded": wait and try again
      if ((res.status === 429 || (res.status === 403 && /quota|rate ?limit/i.test(text))) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
        continue;
      }
      throw new Error(`Google ${url.includes("gmail") ? "Gmail" : "Drive"} ${res.status}: ${text.slice(0, 200)}`);
    }
  };
  return {
    connection: c,
    /** New content for an existing Drive file (a new version; Drive keeps the old ones). Only used to append to the register. */
    replaceContent: async (fileId: string, body: Buffer, contentType: string) => {
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, { method: "PATCH", headers: { Authorization: `Bearer ${access}`, "Content-Type": contentType }, body: new Uint8Array(body), cache: "no-store" });
      if (!res.ok) throw new Error(`Google Drive update ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json() as Promise<{ id: string }>;
    },
    /** Upload a file to Drive (multipart body built by the caller). */
    upload: async (body: Buffer, contentType: string) => {
      const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": contentType }, body: new Uint8Array(body), cache: "no-store" });
      if (!res.ok) throw new Error(`Google Drive upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json() as Promise<{ id: string }>;
    },
    /** POST JSON to a Google API (creating Drive folders, saving Gmail drafts). Nothing in the dashboard sends or deletes. */
    post: async <T>(url: string, body: unknown) => {
      if (/\/send\b|\/delete\b|\/trash\b/.test(url)) throw new Error("The dashboard never sends, deletes or trashes anything");
      const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      if (!res.ok) throw new Error(`Google ${url.includes("gmail") ? "Gmail" : "Drive"} ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json() as Promise<T>;
    },
    /**
     * The ONE email the dashboard sends itself: a new clerk's welcome email, when the person adding them ticks
     * "Email them now" (Ronan, 15 Nov 2026). Everything else is only ever saved as a draft. Don't reuse this.
     */
    sendNewClerkWelcome: async (raw: string) => {
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw }), cache: "no-store" });
      if (!res.ok) throw new Error(`Gmail ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return res.json() as Promise<{ id: string }>;
    },
    /** Gmail API (users/me), e.g. gmail("threads", { q }) */
    gmail: async <T>(path: string, params: Record<string, string | string[]>) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) for (const x of [v].flat()) q.append(k, x);
      return (await call(`https://gmail.googleapis.com/gmail/v1/users/me/${path}?${q}`)).json() as Promise<T>;
    },
    json: async <T>(path: string, params: Record<string, string>) =>
      (await call(`https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`)).json() as Promise<T>,
    download: async (fileId: string) => (await call(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`)).arrayBuffer(),
    /** A Google Sheet saved as .xlsx (Sheets can't be downloaded directly). */
    exportXlsx: async (fileId: string) =>
      (await call(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}`)).arrayBuffer(),
  };
}
