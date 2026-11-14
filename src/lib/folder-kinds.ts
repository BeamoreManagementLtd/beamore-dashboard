/** Kinds of project folder in Google Drive (src/lib/project-setup.ts). */
export type FolderKind = "dfe" | "school" | "other" | "cladding";
export const FOLDER_KINDS: Record<FolderKind, { label: string; parent: "Schools" | "Others"; subfolders: string[] }> = {
  dfe: { label: "DfE school", parent: "Schools", subfolders: ["CPs", "Diaries", "M&E Diaries", "Monthly reports", "Photos"] },
  school: { label: "School (not DfE)", parent: "Schools", subfolders: ["CP's", "Reports", "M&E Reports", "Photos"] },
  other: { label: "Other project", parent: "Others", subfolders: ["CP's", "Reports", "M&E Reports", "Photos"] },
  cladding: { label: "Cladding job", parent: "Others", subfolders: ["CP's", "Reports", "Photos"] },
};
const SCHOOLISH = /\b(school|academy|college|primary|high|grammar|sixth form|infant|junior|SEN|PRU)\b/i;
const CLADDING = /\b(cladding|EWI|fa[cç]ade|remediation|BSF)\b/i;

export function guessFolderKind(p: { name: string; is_dfe: boolean | null }): FolderKind {
  if (p.is_dfe) return "dfe";
  if (CLADDING.test(p.name)) return "cladding";
  if (SCHOOLISH.test(p.name)) return "school";
  return "other";
}

