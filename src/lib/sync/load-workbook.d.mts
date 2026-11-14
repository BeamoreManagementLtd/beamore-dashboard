import type ExcelJS from "exceljs";
export declare function loadWorkbook(data: ArrayBuffer | Buffer | Uint8Array): Promise<ExcelJS.Workbook>;
