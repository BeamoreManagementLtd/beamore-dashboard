import type JSZip from "jszip";
export function solidStyles(zip: JSZip, defs: { font: string | number; rgb: string | null }[]): Promise<number[]>;
export function fontOf(zip: JSZip, styleIndex: number): Promise<string>;
export function sheetPath(zip: JSZip, name: string): Promise<string | null>;
export function addSheet(zip: JSZip, name: string, rows: string[][], opts?: {
  styles?: { head?: string | number; body?: string | number }; styleOf?: (row: number, col: number) => string | number | undefined;
  widths?: number[]; freeze?: { cols?: number; rows?: number }; replace?: boolean;
}): Promise<string>;
