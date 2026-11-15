import "server-only";

/** Working days (Mon-Fri, not England & Wales bank holidays) for report deadlines and timings. */
let holidays: Set<string> | null = null;
export async function loadHolidays() {
  if (holidays) return holidays;
  try {
    const r = await fetch("https://www.gov.uk/bank-holidays.json", { next: { revalidate: 86400 } });
    const j = (await r.json()) as { "england-and-wales": { events: { date: string }[] } };
    holidays = new Set(j["england-and-wales"].events.map((e) => e.date));
  } catch { holidays = new Set(); }
  return holidays;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const isWorking = (d: Date, h: Set<string>) => d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !h.has(iso(d));

/** The date n working days after a date (a report due 1 working day after a Friday visit is due Monday). */
export function addWorkingDays(date: string, n: number, h: Set<string>) {
  const d = new Date(`${date}T00:00:00Z`);
  for (let k = 0; k < n;) { d.setUTCDate(d.getUTCDate() + 1); if (isWorking(d, h)) k++; }
  return iso(d);
}

/** Working days from one date to a later one (0 = same day, 1 = next working day). */
export function workingDaysBetween(from: string, to: string, h: Set<string>) {
  if (to <= from) return 0;
  const d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
  let n = 0;
  while (d < end) { d.setUTCDate(d.getUTCDate() + 1); if (isWorking(d, h)) n++; }
  return n;
}

/** Red / orange / green for the queue, by age (Ronan's colours): red = late, send now; orange = due today; green = fine for now. */
export function rag(due: string | null, today: string): "red" | "orange" | "green" {
  if (due && due < today) return "red";
  if (due && due === today) return "orange";
  return "green";
}
