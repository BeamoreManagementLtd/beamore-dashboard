"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { startUpload, finishUpload } from "./actions";

type Props = { kind: "invoice" | "insurance" | "qualification"; title: string; hint: string; types?: string[]; button: string };

/**
 * Drop or choose one or more files. Every file is accepted: it goes straight to Beamore, then gets filed in the
 * clerk's Personnel folder and checked afterwards. Nothing is refused at this point.
 */
export function UploadBox({ kind, title, hint, types, button }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState(types?.[0] ?? "");
  const [over, setOver] = useState(false);
  const [msgs, setMsgs] = useState<{ name: string; state: "sending" | "done" | "error"; text?: string }[]>([]);
  const router = useRouter();

  async function send(files: FileList | File[]) {
    const list = Array.from(files);
    if (!list.length) return;
    setMsgs(list.map((f) => ({ name: f.name, state: "sending" })));
    const supabase = createClient();
    await Promise.all(list.map(async (f, i) => {
      const set = (state: "done" | "error", text?: string) => setMsgs((m) => m.map((x, j) => (j === i ? { ...x, state, text } : x)));
      try {
        const s = await startUpload({ kind, docType: docType || null, fileName: f.name, mime: f.type || "application/octet-stream", bytes: f.size });
        if (!s.ok) return set("error", s.message);
        const { error } = await supabase.storage.from("portal-uploads").uploadToSignedUrl(s.path, s.token, f, { contentType: f.type || "application/octet-stream" });
        if (error) return set("error", "The upload was interrupted. Please try again.");
        const done = await finishUpload(s.receipt);
        set(done.ok ? "done" : "error", done.ok ? `Received · ref ${s.receipt.slice(0, 8)}` : done.message);
      } catch {
        set("error", "The upload was interrupted. Please try again.");
      }
    }));
    router.refresh();
  }

  return (
    <div
      className={`drop${over ? " over" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); send(e.dataTransfer.files); }}
    >
      <div className="drop-icon" aria-hidden>⬆</div>
      <b>{title}</b>
      <p className="muted small">{hint}</p>
      {types && (
        <label className="small">What is it?{" "}
          <select value={docType} onChange={(e) => setDocType(e.target.value)}>{types.map((t) => <option key={t}>{t}</option>)}</select>
        </label>
      )}
      <button className="btn primary" type="button" onClick={() => input.current?.click()}>{button}</button>
      <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) send(e.target.files); e.target.value = ""; }} />
      {!!msgs.length && (
        <ul className="drop-list">
          {msgs.map((m, i) => (
            <li key={i} className={m.state}>
              <span>{m.name}</span>
              <span className="small">{m.state === "sending" ? "Sending…" : m.state === "done" ? `✓ ${m.text}` : m.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
