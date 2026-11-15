import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Reads an uploaded certificate or invoice with Claude and returns the facts as JSON. The clerk never types these in.
 * Runs after the file is already saved and filed, so a failure here never loses an upload; it just leaves an issue.
 */
export const AI_MODEL = "claude-opus-5-5";

export type Kind = "insurance" | "qualification" | "invoice" | "company_invoice";

const s = { type: "string" } as const;
const ns = { type: ["string", "null"] } as const;
const nn = { type: ["number", "null"] } as const;

const INSURANCE = {
  type: "object", additionalProperties: false,
  required: ["readable", "is_insurance_document", "insured_name", "insurer", "policy_number", "policies", "problems"],
  properties: {
    readable: { type: "boolean", description: "false if the document is too blurred, cut off or incomplete to read reliably" },
    is_insurance_document: { type: "boolean" },
    insured_name: { ...ns, description: "the policyholder / insured exactly as written (person or company)" },
    insurer: ns,
    policy_number: ns,
    policies: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["type", "description", "cover_gbp", "starts", "expires"],
        properties: {
          type: { type: "string", enum: ["PI", "PL", "EL", "other"], description: "PI professional indemnity, PL public liability, EL employers liability" },
          description: s,
          cover_gbp: { ...nn, description: "the LIMIT OF INDEMNITY in pounds for this cover (e.g. 1000000). Never the turnover, fee income, excess, premium or a sub-limit" },
          starts: { ...ns, description: "YYYY-MM-DD" },
          expires: { ...ns, description: "YYYY-MM-DD (the end / renewal date)" },
        },
      },
    },
    problems: { type: "array", items: s, description: "anything missing or unclear, in plain English" },
  },
};

const QUALIFICATION = {
  type: "object", additionalProperties: false,
  required: ["readable", "doc_type", "holder_name", "body", "grade", "number", "issued", "expires", "problems"],
  properties: {
    readable: { type: "boolean" },
    doc_type: { type: "string", description: "e.g. CSCS card, MCIOB, MICWCI, MCABE, NEBOSH, SMSTS, degree, other" },
    holder_name: ns,
    body: { ...ns, description: "issuing body, e.g. CIOB, ICWCI, CABE, CSCS" },
    grade: { ...ns, description: "card colour / membership grade, e.g. Gold (Supervisor), Member" },
    number: { ...ns, description: "card, registration or membership number" },
    issued: { ...ns, description: "YYYY-MM-DD" },
    expires: { ...ns, description: "YYYY-MM-DD, null if it has no expiry" },
    problems: { type: "array", items: s },
  },
};

const INVOICE = {
  type: "object", additionalProperties: false,
  required: ["readable", "is_invoice", "supplier", "invoice_number", "invoice_date", "period", "net_gbp", "vat_gbp", "gross_gbp", "cis", "days", "lines", "visits", "problems"],
  properties: {
    readable: { type: "boolean" },
    is_invoice: { type: "boolean" },
    supplier: { ...ns, description: "the person or company issuing the invoice" },
    invoice_number: ns,
    invoice_date: { ...ns, description: "YYYY-MM-DD" },
    period: { ...ns, description: "the month the work was done, YYYY-MM" },
    net_gbp: nn, vat_gbp: nn, gross_gbp: nn,
    cis: { type: "boolean", description: "true if a CIS deduction is shown" },
    days: { ...nn, description: "total days or visits charged, if stated" },
    lines: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["text", "amount_gbp"], properties: { text: s, amount_gbp: nn } },
    },
    visits: {
      type: "array",
      description: "one entry per day per site worked, as listed on the invoice (or its timesheet). Empty if the invoice doesn't say which days",
      items: {
        type: "object", additionalProperties: false, required: ["date", "site", "half_days"],
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          site: { type: "string", description: "the site / project exactly as worded on the invoice" },
          half_days: { type: "integer", description: "1 = half day / one visit, 2 = full day" },
        },
      },
    },
    problems: { type: "array", items: s },
  },
};

const PROMPTS: Record<Kind, { schema: object; ask: string }> = {
  insurance: { schema: INSURANCE, ask: "This is an insurance certificate or schedule uploaded by a self-employed clerk of works. Read every cover section on it (professional indemnity, public liability, employers liability, other), with the limit of indemnity in pounds and the period of insurance. Certificates often also show turnover, fee income, excess or premium figures: ignore those, the cover is the limit of indemnity (often 'any one claim' or 'in the aggregate'). Don't guess: use null for anything not shown." },
  qualification: { schema: QUALIFICATION, ask: "This is a qualification, membership certificate or card (for example a CSCS card or a CIOB membership certificate) uploaded by a clerk of works. Read what it is, whose it is, the number and any expiry. Don't guess: use null for anything not shown." },
  invoice: { schema: INVOICE, ask: "This is an invoice sent to Beamore Management Ltd by a clerk of works (or their company) for site visits. Read the invoice details. Amounts in pounds. List every dated visit in 'visits' (a full day is 2 half-days; a single visit or half day is 1). Don't guess: use null for anything not shown, and leave 'visits' empty if dates aren't listed." },
  company_invoice: { schema: INVOICE, ask: "This is an invoice sent to Beamore Management Ltd by a clerk of works' company for site visits. Read the invoice details. Amounts in pounds. Don't guess: use null for anything not shown." },
};

export function aiConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

export async function readDocument(kind: Kind, file: Buffer, mime: string): Promise<Record<string, unknown>> {
  if (!aiConfigured()) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic();
  const p = PROMPTS[kind];
  const data = file.toString("base64");
  const doc = mime === "application/pdf"
    ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data } }
    : { type: "image" as const, source: { type: "base64" as const, media_type: (["image/png", "image/gif", "image/webp"].includes(mime) ? mime : "image/jpeg") as "image/jpeg", data } };
  const res = await client.messages.create({
    model: AI_MODEL,
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: p.schema } },
    messages: [{ role: "user", content: [doc, { type: "text", text: p.ask }] }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  if (res.stop_reason === "refusal") throw new Error("The AI declined to read this document");
  const text = res.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("The AI returned no answer");
  return JSON.parse(text.text);
}

const MATCH = {
  type: "object", additionalProperties: false, required: ["matches"],
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["wording", "site", "certain"],
        properties: {
          wording: s,
          site: { ...ns, description: "one name copied exactly from the list, or null" },
          certain: { type: "boolean", description: "true only if this is clearly the same site" },
        },
      },
    },
  },
};

/** Maps how a clerk worded each site on an invoice to the exact name already used in the diary. */
export async function matchSites(wordings: string[], clerkSites: string[], otherSites: string[]) {
  if (!aiConfigured()) throw new Error("ANTHROPIC_API_KEY is not set");
  const client = new Anthropic();
  const text = `A clerk of works has written these site names on their invoice:
${wordings.map((w) => `- ${w}`).join("\n")}

The diary must use one of these exact names. Sites this clerk has worked at recently (most likely):
${clerkSites.map((n) => `- ${n}`).join("\n") || "(none)"}

Other sites in the rates list:
${otherSites.map((n) => `- ${n}`).join("\n") || "(none)"}

For each invoice wording, pick the one name from the lists that is the same site (location, school/client name or project number can show this). Copy it exactly. If no name clearly fits, or two could fit, give null and certain=false.`;
  const res = await client.messages.create({
    model: AI_MODEL, max_tokens: 3000,
    output_config: { effort: "low", format: { type: "json_schema", schema: MATCH } },
    messages: [{ role: "user", content: text }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const t = res.content.find((b) => b.type === "text");
  if (!t || t.type !== "text") throw new Error("The AI returned no answer");
  return (JSON.parse(t.text) as { matches: { wording: string; site: string | null; certain: boolean }[] }).matches;
}
