import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueueRow, LogRow } from "./reports-parse.mjs";
export declare function writeQueue(admin: SupabaseClient, rows: QueueRow[], scannedAt: string): Promise<string>;
export declare function writeLog(admin: SupabaseClient, rows: LogRow[]): Promise<string>;
