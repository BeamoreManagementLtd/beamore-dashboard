export const CONTACT_HEADERS: string[];
export const CONTACT_COLS: number;
export type ContactClerk = {
  name: string; email: string | null; personal_email: string | null; phone: string | null; self_entered: boolean;
  companies: string[]; compliance: Record<string, string | boolean | null> | null;
};
export function companyLabel(person: string, companies: string[]): string | null;
export function contactRows(existing: string[][], clerks: ContactClerk[]): string[][];
