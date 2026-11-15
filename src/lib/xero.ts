import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Apps created after 2 March 2026 must ask for granular scopes. accounting.invoices (not just .read) lets the monthly
// sign-off create DRAFT invoices; nothing is ever approved or sent from the dashboard.
export const XERO_SCOPES =
  process.env.XERO_SCOPES ??
  "openid profile email offline_access accounting.invoices accounting.settings accounting.reports.profitandloss.read accounting.reports.banksummary.read";
// accounting.settings: only used when the director clicks "Set up Project tracking" (adds the category and its options),
// and to read the Project options so draft invoices can be tagged. Connections made before this date lack it.
export const SCOPES_CHANGED_AT = "2026-11-14T17:00:00Z";
const AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const TOKEN_URL = "https://identity.xero.com/connect/token";
const API = "https://api.xero.com";

type Tokens = { access_token: string; refresh_token: string; expires_in: number };

function basicAuth() {
  const id = process.env.XERO_CLIENT_ID, secret = process.env.XERO_CLIENT_SECRET;
  if (!id || !secret) throw new Error("XERO_CLIENT_ID and XERO_CLIENT_SECRET are not set");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

export function authorizeUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({
    response_type: "code", client_id: process.env.XERO_CLIENT_ID ?? "", redirect_uri: redirectUri, scope: XERO_SCOPES, state,
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Xero token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** First connection: swap the sign-in code for tokens, pick the Beamore organisation and store it. */
export async function connect(admin: SupabaseClient, code: string, redirectUri: string, userId: string) {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  const res = await fetch(`${API}/connections`, { headers: { Authorization: `Bearer ${t.access_token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Xero connections failed (${res.status})`);
  const orgs: { tenantId: string; tenantName: string; tenantType: string }[] = await res.json();
  const org =
    orgs.find((o) => o.tenantId === process.env.XERO_TENANT_ID) ??
    orgs.find((o) => o.tenantType === "ORGANISATION" && /beamore/i.test(o.tenantName)) ??
    orgs.find((o) => o.tenantType === "ORGANISATION");
  if (!org) throw new Error("No Xero organisation was shared with the dashboard");
  const { error } = await admin.from("xero_connection").upsert({
    id: 1, tenant_id: org.tenantId, tenant_name: org.tenantName, refresh_token: t.refresh_token, access_token: t.access_token,
    access_expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    connected_by: userId, connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`Saving the Xero connection failed: ${error.message}`);
  return org.tenantName;
}

/** A Xero API caller for the stored organisation. Refreshes the 30-minute access token as needed;
 *  Xero rotates the refresh token every time, so the new one is saved straight away. */
export async function xeroClient(admin: SupabaseClient) {
  const { data: c, error } = await admin.from("xero_connection").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  if (!c) throw new Error("Xero is not connected yet (Finance → Connect Xero)");
  let access = c.access_token as string | null;
  if (!access || !c.access_expires_at || new Date(c.access_expires_at) < new Date()) {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: c.refresh_token });
    access = t.access_token;
    const { error: e } = await admin.from("xero_connection").update({
      refresh_token: t.refresh_token, access_token: t.access_token, updated_at: new Date().toISOString(),
      access_expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    }).eq("id", 1);
    if (e) throw new Error(`Saving the refreshed Xero token failed: ${e.message}`);
  }
  const call = async <T>(method: "GET" | "PUT" | "POST" | "DELETE", path: string, params: Record<string, string | number>, body?: unknown): Promise<T> => {
    const url = `${API}/api.xro/2.0/${path}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${access}`, "Xero-tenant-id": c.tenant_id, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
      if (res.status === 429 && attempt < 2) { // rate limit: wait as told, then retry
        await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 5) * 1000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        // Xero's reason is buried in Elements[].ValidationErrors: put it first so it survives the length limit
        const reasons = [...text.matchAll(/"Message":\s*"([^"]+)"/g)].map((m) => m[1]).filter((m) => m !== "A validation exception occurred");
        throw new Error(`Xero ${path} failed (${res.status}): ${reasons.length ? reasons.join("; ") + " | " : ""}${text.slice(0, 300)}`);
      }
      return res.json() as Promise<T>;
    }
  };
  const get = <T>(path: string, params: Record<string, string | number> = {}) => call<T>("GET", path, params);
  /** Creates records (e.g. draft invoices). Needs the write scope (accounting.invoices). */
  const put = <T>(path: string, body: unknown, params: Record<string, string | number> = {}) => call<T>("PUT", path, params, body);
  /** Updates a record (only used to archive tracking options for finished and lost projects). */
  const post = <T>(path: string, body: unknown) => call<T>("POST", path, {}, body);
  /** Only used to delete tracking options never used on an invoice, for finished/lost/merged jobs. */
  const del = <T>(path: string) => call<T>("DELETE", path, {});
  return Object.assign(get, { put, post, del });
}
export type XeroGet = Awaited<ReturnType<typeof xeroClient>>;
