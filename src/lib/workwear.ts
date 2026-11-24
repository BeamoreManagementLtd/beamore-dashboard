/**
 * Workwear ordering on the clerk portal (Ronan, 24 Nov 2026), replacing the Apps Script form and the "Beamore Workwear
 * Orders" sheet. The same rules as the old form: shirts and polos up to the days a week worked, then one each of a vest,
 * a sweatshirt or fleece, outerwear (softshell, gilet, bodywarmer) and a hi-vis jacket. Someone can only order while
 * they're switched on; ordering switches them off again.
 */
export type WorkwearItem = { id: string; type: string; name: string; supplier_code: string | null; image_url: string | null; active: boolean; sort: number };
export type WorkwearVariant = { item_id: string; colour: string; size: string; supplier_code: string | null; image_url: string | null; active: boolean; sort: number };
export type OrderLine = { item_id: string; colour: string; size: string; quantity: number };

/** The sections of the form, in order, and how many of each can be chosen ("days" = up to the days a week worked). */
export const SECTIONS: { key: string; title: string; types: string[]; limit: number | "days"; note: string }[] = [
  { key: "shirts", title: "Shirts and polo shirts", types: ["polo", "shirt"], limit: "days", note: "Shirts, polo shirts or both, up to the number of days a week you work for Beamore." },
  { key: "vest", title: "Vest", types: ["vest"], limit: 1, note: "One Beamore-branded hi-vis vest, or leave this blank." },
  { key: "jumper", title: "Sweatshirt or fleece", types: ["jumper"], limit: 1, note: "One Beamore-branded sweatshirt or fleece, or leave this blank." },
  { key: "outerwear", title: "Outerwear", types: ["outerwear"], limit: 1, note: "One Beamore-branded gilet, bodywarmer or softshell jacket, or leave this blank." },
  { key: "hivis", title: "Hi-vis jacket", types: ["hivis"], limit: 1, note: "One Beamore-branded hi-vis jacket, as well as your outerwear, or leave this blank." },
];

export const STATUS_LABEL: Record<string, string> = { requested: "Ordered: waiting to be sent to the supplier", ordered: "With the supplier", delivered: "Delivered", cancelled: "Cancelled" };

/** Problems with an order against the rules (empty when it's fine). */
export function orderProblems(lines: OrderLine[], items: WorkwearItem[], variants: WorkwearVariant[], days: number): string[] {
  const out: string[] = [];
  if (!lines.length) out.push("Nothing chosen yet");
  for (const l of lines) {
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 10) out.push("Each quantity must be between 1 and 10");
    const it = items.find((i) => i.id === l.item_id && i.active);
    if (!it) { out.push("An item that's no longer available was chosen"); continue; }
    if (!variants.some((v) => v.item_id === l.item_id && v.colour === l.colour && v.size === l.size && v.active)) out.push(`${it.name}: that colour and size isn't available`);
  }
  for (const s of SECTIONS) {
    const n = lines.filter((l) => s.types.includes(items.find((i) => i.id === l.item_id)?.type ?? "")).reduce((a, l) => a + l.quantity, 0);
    const max = s.limit === "days" ? days : s.limit;
    if (n > max) out.push(`${s.title}: up to ${max} (you've chosen ${n})`);
  }
  return [...new Set(out)];
}
