import type ExcelJS from "exceljs";
export type QueueRow = { checker: string; folder: string | null; main_folder: string | null; project_name: string; report_name: string; report_date: string | null; due: string | null };
export type LogRow = {
  drive_file_id: string; clerk_name: string | null; project_name: string | null; visit_date: string | null; report_date: string | null;
  working_days: number | null; status: string | null; reason: string | null; report_name: string | null; checker: string | null; checked_at: string | null;
};
export declare function parseQueue(wb: ExcelJS.Workbook): QueueRow[];
export declare function parseLog(wb: ExcelJS.Workbook): LogRow[];
