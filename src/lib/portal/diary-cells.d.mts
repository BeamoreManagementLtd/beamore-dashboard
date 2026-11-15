export function setCell(xml: string, ref: string, text: string): string;
export function cellStyle(xml: string, ref: string): { tag: string; s: string } | null;
export function greenVersion(styles: string, from: number): number | null;
