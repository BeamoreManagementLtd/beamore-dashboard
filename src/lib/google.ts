import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Read-only Drive access: the dashboard downloads Diary 2026.xlsx and never changes it.
export const GOOGLE_SCOPES = process.env.GOOGLE_SCOPES ?? "openid email https://www.googleapis.com/auth/drive.readonly";

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
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access}` }, cache: "no-store" });
    if (!res.ok) throw new Error(`Google Drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  return {
    connection: c,
    json: async <T>(path: string, params: Record<string, string>) =>
      (await call(`https://www.googleapis.com/drive/v3/${path}?${new URLSearchParams(params)}`)).json() as Promise<T>,
    download: async (fileId: string) => (await call(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`)).arrayBuffer(),
  };
}
