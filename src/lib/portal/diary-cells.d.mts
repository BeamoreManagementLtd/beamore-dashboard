export function setCell(xml: string, ref: string, text: string, style?: string | number): string;
export function setColWidths(xml: string, widths: Record<number, number>): string;
export function cellStyle(xml: string, ref: string): { tag: string; s: string } | null;
export function greenVersion(styles: string, from: number): number | null;
