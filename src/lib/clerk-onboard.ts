import "server-only";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { driveClient } from "@/lib/google";
import { clerkFolder, ensureJoinToken, PPE_ITEMS } from "@/lib/clerk-join";
import { joinLink } from "@/lib/join-link";

/**
 * New clerk onboarding, start to finish (Ronan, 15 Nov 2026). From one "Add new clerk" form:
 *  1. their @beamore.co.uk Google account (temporary password, changed at first sign-in; Ronan passes it on himself)
 *  2. their Personnel folder, for the office only: never shared with them (Ronan, 16 Nov 2026)
 *  3. the project folder for the job they're going on, shared the same way
 *  4. the Beamore manual (once Andy's written it and its Drive link is saved), shared read-only
 *  5. portal access (portal.beamore.co.uk) and the onboarding checklist
 *  6. a welcome email to their current address: SENT if "Email them now" is ticked (with their temporary password),
 *     otherwise saved as a draft. This is the only email the dashboard ever sends itself (Ronan, 15 Nov 2026)
 *  7. a to-do for Ronan to send their PPE (helmet and vest), and to give them their password if it wasn't emailed
 */
export type Step = { label: string; ok: boolean; note?: string };

const share = async (g: Awaited<ReturnType<typeof driveClient>>, fileId: string, email: string, role: "writer" | "reader") =>
  g.post(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, { type: "user", role, emailAddress: email });

/** A readable temporary password, e.g. "Beamore-k7Pq-3vXa-92". Only shown to Ronan, once; never stored. */
function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pick = (n: number) => Array.from(randomBytes(n), (b) => abc[b % abc.length]).join("");
  return `Beamore-${pick(4)}-${pick(4)}-${pick(2)}`;
}

export async function onboardNewClerk(admin: SupabaseClient, o: {
  clerkId: string; name: string; personalEmail: string | null; beamoreEmail: string | null; phone: string | null; projectId: string | null; createAccount: boolean; sendWelcome: boolean; addedBy: string;
}) {
  const steps: Step[] = [];
  let password: string | undefined;
  const g = await driveClient(admin);
  const [givenName, ...rest] = o.name.trim().split(/\s+/);
  const familyName = rest.join(" ") || givenName;
  const email = o.beamoreEmail?.toLowerCase() || null;

  // 1. Google Workspace account
  if (email && o.createAccount) {
    password = tempPassword();
    try {
      // UK mobile in international form for Google (07... -> +447...), used for sign-in checks and account recovery
      const intl = o.phone ? o.phone.replace(/[^0-9+]/g, "").replace(/^0/, "+44").replace(/^44/, "+44") : null;
      await g.post("https://admin.googleapis.com/admin/directory/v1/users", {
        primaryEmail: email, name: { givenName, familyName }, password, changePasswordAtNextLogin: true,
        ...(intl ? { phones: [{ value: intl, type: "mobile", primary: true }], recoveryPhone: intl } : {}),
        ...(o.personalEmail ? { recoveryEmail: o.personalEmail } : {}),
      });
      steps.push({ label: `Google account ${email} created`, ok: true, note: "They'll be asked to choose their own password the first time they sign in" });
    } catch (e) {
      password = undefined;
      const m = e instanceof Error ? e.message : String(e);
      steps.push({ label: `Google account ${email}`, ok: /409|already exists|duplicate/i.test(m),
        note: /409|already exists|duplicate/i.test(m) ? "Already exists, so it was left as it is"
          : /403|insufficient|scope|not been used|disabled/i.test(m) ? "Not allowed yet: reconnect Google on the Finance page (it now asks for permission to create users). If it still fails, the Admin SDK API needs switching on in Google Cloud"
          : m.slice(0, 200) });
    }
  }

  // 2 + 3 + 4. folders and the manual, shared with their new address
  let projectFolder: string | null = null, projectName: string | null = null, manualLink: string | null = null;
  try {
    // made for the office, NOT shared with the clerk (Ronan, 16 Nov 2026): their uploads reach it through the portal
    await clerkFolder(admin, o.clerkId, o.name);
    steps.push({ label: "Personnel folder made", ok: true, note: "For the office only; not shared with them" });
  } catch (e) { steps.push({ label: "Personnel folder", ok: false, note: e instanceof Error ? e.message.slice(0, 200) : "failed" }); }
  if (o.projectId) {
    const { data: p } = await admin.from("projects").select("display_name,drive_folder_id").eq("id", o.projectId).single();
    projectName = p?.display_name ?? null;
    projectFolder = p?.drive_folder_id ?? null;
    if (!projectFolder) {
      try { const { ensureProjectFolder } = await import("@/lib/project-setup"); await ensureProjectFolder(admin, o.projectId); projectFolder = (await admin.from("projects").select("drive_folder_id").eq("id", o.projectId).single()).data?.drive_folder_id ?? null; } catch { /* reported below */ }
    }
    if (projectFolder && email) {
      try { await share(g, projectFolder, email, "writer"); steps.push({ label: `${projectName} folder shared with them`, ok: true }); }
      catch (e) { steps.push({ label: `${projectName} folder`, ok: false, note: e instanceof Error ? e.message.slice(0, 200) : "failed" }); }
    } else if (!projectFolder) steps.push({ label: `${projectName} folder`, ok: false, note: "The project has no Drive folder yet" });
  }
  const { data: settings } = await admin.from("onboarding_settings").select("manual_file_id").eq("id", 1).maybeSingle();
  if (settings?.manual_file_id) {
    manualLink = `https://drive.google.com/file/d/${settings.manual_file_id}/view`;
    if (email) {
      try { await share(g, settings.manual_file_id, email, "reader"); steps.push({ label: "Beamore manual shared with them", ok: true }); }
      catch (e) { steps.push({ label: "Beamore manual", ok: false, note: e instanceof Error ? e.message.slice(0, 200) : "failed" }); }
    }
  } else steps.push({ label: "Beamore manual", ok: false, note: "Not set up yet: add the manual's Drive link on the Personnel page once Andy's finished it, and new clerks will get it automatically" });

  // 5. portal access + questionnaire link
  await admin.from("clerks").update({ ...(email ? { email } : {}), personal_email: o.personalEmail, portal_access: true, invoice_upload: true }).eq("id", o.clerkId);
  const token = await ensureJoinToken(admin, o.clerkId);
  steps.push({ label: "Portal access switched on", ok: true, note: "portal.beamore.co.uk" });

  // 6. welcome email: SENT to their current address when "Email them now" is ticked (Ronan's one exception to
  // "never send", 15 Nov 2026), otherwise saved as a draft. The temporary password only goes in a sent email.
  const sendNow = o.sendWelcome && !!o.personalEmail;
  const to = o.personalEmail || email;
  if (to) {
    const first = givenName;
    const signIn = email && password && sendNow
      ? [`Your Beamore email address is ${email} and your temporary password is ${password}. Sign in at https://mail.google.com; you'll be asked to choose your own password straight away.`, ""]
      : email ? [`Your Beamore email address is ${email}. I'll send you a temporary password separately; you'll be asked to choose your own when you first sign in at https://mail.google.com.`, ""] : [];
    const lines = [
      `Hi ${first},`, "",
      "Welcome to Beamore. Here's everything you need to get started.", "",
      ...(email ? [...signIn,
        "Once you're in, please turn on 2-Step Verification straight away: go to https://myaccount.google.com/signinoptions/two-step-verification and follow the steps (it texts a code to your phone). This keeps your Beamore account and our clients' information safe.", ""] : []),
      ...(email ? ["1. Sign in to our portal at https://portal.beamore.co.uk with your " + email + " account. The first time, it asks for your details (phone, address, next of kin, DBS and PPE sizes). Please also upload your insurance certificate and CSCS card there.", ""]
        : ["1. Please fill in this short form with your details (address, next of kin, insurance, DBS and CSCS) and let us know your PPE sizes:", joinLink(token), ""]),
      "2. The portal is also where you upload your monthly invoices and see your certificates.", "",
      ...(projectFolder ? [`3. Your project folder for ${projectName}, where your reports go: https://drive.google.com/drive/folders/${projectFolder}`, ""] : []),
      ...(manualLink ? [`${projectFolder ? "4" : "3"}. The Beamore manual, which explains how we work: ${manualLink}`, ""] : []),
      `We'll send you your Beamore PPE (${PPE_ITEMS.join(" and ").toLowerCase()}).`, "",
      "Any questions, just give me a call.", "",
      "Many thanks,", "Ronan", "", "Ronan O'Boyle", "Beamore Management Ltd",
    ];
    const CRLF = String.fromCharCode(13, 10);
    const raw = [`To: ${to}`, ...(o.personalEmail && email ? [`Cc: ${email}`] : []), "Subject: Welcome to Beamore", "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8"].join(CRLF) + CRLF + CRLF + lines.join(CRLF);
    const encoded = Buffer.from(raw).toString("base64url");
    if (sendNow) {
      try { await g.sendNewClerkWelcome(encoded); steps.push({ label: `Welcome email sent to ${to}`, ok: true, note: password ? "Includes their temporary password; a copy is in your Sent folder" : "A copy is in your Sent folder" }); }
      catch (e) {
        steps.push({ label: "Welcome email", ok: false, note: `Couldn't send (${e instanceof Error ? e.message.slice(0, 120) : "error"}), so it's saved in your Drafts instead` });
        await g.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw: encoded } }).catch(() => undefined);
      }
    } else {
      try { await g.post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", { message: { raw: encoded } }); steps.push({ label: `Welcome email saved in your Gmail Drafts (to ${to})`, ok: true, note: "Not sent: check it and press Send" }); }
      catch (e) { steps.push({ label: "Welcome email draft", ok: false, note: e instanceof Error ? e.message.slice(0, 200) : "failed" }); }
    }
  }
  const passwordSent = !!password && sendNow && steps.some((s) => s.ok && s.label.startsWith("Welcome email sent"));

  // 7. Ronan's to-dos
  const { data: ronan } = await admin.from("profiles").select("id").eq("role", "director").limit(1).single();
  const soon = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
  await admin.from("tasks").insert([
    { owner_id: ronan?.id ?? null, title: `Send ${o.name} their Beamore PPE (${PPE_ITEMS.join(" and ").toLowerCase()})`, kind: "New clerk", due: soon, link: `/personnel/${o.clerkId}` },
    ...(password && !passwordSent ? [{ owner_id: ronan?.id ?? null, title: `Give ${o.name} their temporary password for ${email}`, kind: "New clerk", due: new Date().toISOString().slice(0, 10), link: `/personnel/${o.clerkId}` }] : []),
  ]);
  steps.push({ label: `PPE${password && !passwordSent ? " and password" : ""} to-do added to your list`, ok: true });
  await admin.from("portal_audit").insert({ actor: o.addedBy, action: "new-clerk-onboarded", detail: { clerkId: o.clerkId, email, steps: steps.map((s) => [s.label, s.ok]) } });
  return { steps, password, passwordSent };
}
