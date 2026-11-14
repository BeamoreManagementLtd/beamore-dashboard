import type { SupabaseClient } from "@supabase/supabase-js";
import type { parseDiary } from "./diary-parse.mjs";
export declare function writeDiary(admin: SupabaseClient, d: ReturnType<typeof parseDiary>, label: string): Promise<string>;
