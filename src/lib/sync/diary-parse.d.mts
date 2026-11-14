import type ExcelJS from "exceljs";
export type DiaryVisit = { date: string; clerk: string; site: string; kind: "building" | "me"; side: "planned" | "charged"; cost: number | null; sheet: string; row: number };
export type DiaryAbsence = { clerk: string; date: string; kind: string; note: string };
export type DiaryInvoiceLine = { month: string; number: string; site: string; kind: "building" | "me"; days: number; rate: number | null };
export declare function parseDiary(wb: ExcelJS.Workbook, opts?: { year?: number; fileLabel?: string }): {
  visits: DiaryVisit[]; absences: DiaryAbsence[]; invoiceLines: DiaryInvoiceLine[];
  rates: { site: string; charge: number | null; pay: number | null }[]; clerks: string[];
  invoiceEmails: { label: string; to: string[]; cc: string[]; notes: string | null }[];
};
