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
          cover_gbp: { ...nn, description: "limit of indemnity in pounds, e.g. 1000000" },
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
  required: ["readable", "is_invoice", "supplier", "invoice_number", "invoice_date", "period", "net_gbp", "vat_gbp", "gross_gbp", "cis", "days", "lines", "problems"],
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
    problems: { type: "array", items: s },
  },
};

const PROMPTS: Record<Kind, { schema: object; ask: string }> = {
  insurance: { schema: INSURANCE, ask: "This is an insurance certificate or schedule uploaded by a self-employed clerk of works. Read every cover section on it (professional indemnity, public liability, employers liability, other), with the limit of indemnity in pounds and the period of insurance. Don't guess: use null for anything not shown." },
  qualification: { schema: QUALIFICATION, ask: "This is a qualification, membership certificate or card (for example a CSCS card or a CIOB membership certificate) uploaded by a clerk of works. Read what it is, whose it is, the number and any expiry. Don't guess: use null for anything not shown." },
  invoice: { schema: INVOICE, ask: "This is an invoice sent to Beamore Management Ltd by a clerk of works (or their company) for site visits. Read the invoice details. Amounts in pounds. Don't guess: use null for anything not shown." },
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
