/** What Beamore needs from the client at the start of a project (Ronan, 14 Nov 2026). */
export const INFO_DFE = [
  "DfE project director", "DfE project manager", "DfE project number", "Principal contractor project number",
  "TA name", "Principal contractor project manager", "CPs for the project (WeTransfer or similar)",
  "PO or project number for invoicing", "Distribution list for reports",
];
export const INFO_STANDARD = [
  "Contact info", "Site contacts & address", "PO number", "CPs, drawings and specification",
  "Distribution list for reports",
];
/** No longer asked for: the client already sent it so we could price the job (Programme: Ronan, 16 Nov 2026). Taken off
 *  automatic checklists unless it's already been received. */
export const INFO_RETIRED = ["Programme"];
/** Items now asked for as one (Ronan, 16 Nov 2026: "the CPs and the drawings specifications are kind of one thing").
 *  On open automatic checklists the old items are replaced by the new one, keeping any progress. */
export const INFO_MERGED: Record<string, string[]> = { "CPs, drawings and specification": ["Copy of CPs", "Drawings & specification"] };
