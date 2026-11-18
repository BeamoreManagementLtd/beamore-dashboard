"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { startPrecheck, finishPrecheck } from "./actions";

/**
 * Check a draft report before putting it in Google Drive (Ronan, 18 Nov 2026). Choose the job and the Word file; it
 * goes to the dashboard only (not Drive, not the office) and the feedback page opens while it's checked.
 */
export function PrecheckBox({ jobs, disabled }: { jobs: { id: string; name: string }[]; disabled?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [job, setJob] = useState(jobs.length === 1 ? jobs[0].id : "");
  const [over, setOver] = useState(false);
  const [msg, setMsg] = useState<{ state: "sending" | "error"; text: string } | null>(null);
  const router = useRouter();

  async function send(files: FileList | File[]) {
    const f = Array.from(files)[0];
    if (!f) return;
    if (!job) return setMsg({ state: "error", text: "Please choose the job first." });
    setMsg({ state: "sending", text: `Uploading ${f.name}… the check then takes a few minutes.` });
    try {
      const s = await startPrecheck({ projectId: job, fileName: f.name, bytes: f.size });
      if (!s.ok) return setMsg({ state: "error", text: s.message });
      const type = f.type || "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const { error } = await createClient().storage.from("report-prechecks").uploadToSignedUrl(s.path, s.token, f, { contentType: type });
      if (error) return setMsg({ state: "error", text: "The upload was interrupted. Please try again." });
      const done = await finishPrecheck(s.id);
      if (!done.ok) return setMsg({ state: "error", text: "Couldn't start the check. Please try again." });
      router.push(`/portal/reports/check/${s.id}`);
    } catch {
      setMsg({ state: "error", text: "The upload was interrupted. Please try again." });
    }
  }

  if (disabled) return <p className="muted small">{disabled}</p>;
  if (!jobs.length) return <p className="muted small">You&apos;re not on any jobs at the moment.</p>;
  return (
    <div
      className={`drop${over ? " over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}
    >
      <div className="drop-icon" aria-hidden>✓</div>
      <b>Upload your report here for a pre-check</b>
      <p className="small" style={{ margin: "4px 0" }}>
        1. Choose the job and your Word file. 2. Wait a few minutes while it&apos;s checked: the results open on this page and are
        emailed to you too. 3. Put right anything you want to in Word. 4. Upload the final report to the job&apos;s Google Drive
        folder as normal.
      </p>
      <p className="muted small" style={{ margin: "4px 0" }}>
        This is only a check. Nothing in your report is changed, and the copy you upload here does <b>not</b> go into Google Drive
        or to the office, so you still need to upload your report to Google Drive yourself.
      </p>
      <label className="small">Job{" "}
        <select value={job} onChange={(e) => setJob(e.target.value)}>
          {jobs.length > 1 && <option value="">Choose…</option>}
          {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
      </label>
      <button className="btn primary" type="button" disabled={msg?.state === "sending"} onClick={() => input.current?.click()}>Upload report for a pre-check (.docx)</button>
      <input ref={input} type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden onChange={(e) => { if (e.target.files) send(e.target.files); e.target.value = ""; }} />
      {msg && <p className={`small ${msg.state === "error" ? "neg" : "muted"}`}>{msg.text}</p>}
    </div>
  );
}
