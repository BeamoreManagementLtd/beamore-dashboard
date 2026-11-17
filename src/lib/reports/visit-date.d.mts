export function visitDateFor(rep: { file_name: string; uploaded_at: string }, diaryDates: string[]): { visit_date: string | null; visit_date_source: string };
export function parseNameDate(name: string, uploaded: string): { date: string; week?: "of" | "ending" } | { monthly: string } | null;
