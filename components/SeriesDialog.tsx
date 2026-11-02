"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CircleAlert, LoaderCircle, X } from "lucide-react";
import type { Book } from "@/lib/types";
import { isDialogBackdropClick, showModalDialog } from "@/lib/client/dialog";

export default function SeriesDialog({ book, seriesNames, onClose, onSaved, onUnauthorized }: {
  book: Book;
  seriesNames: string[];
  onClose: () => void;
  onSaved: (book: Book) => void;
  onUnauthorized: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(book.seriesTitle || "");
  const [type, setType] = useState<"volume" | "chapter">(book.installmentType || "volume");
  const [number, setNumber] = useState(book.installmentNumber?.toString() || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (dialogRef.current) return showModalDialog(dialogRef.current);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const seriesTitle = name.trim() || null;
    const installmentNumber = seriesTitle && number.trim() ? Number(number) : null;
    if (installmentNumber !== null && (!Number.isFinite(installmentNumber) || installmentNumber < 0)) {
      setError("Enter a number of zero or greater, or leave it blank for a special.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/books/${book.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesTitle, installmentType: seriesTitle ? type : null, installmentNumber }),
      });
      if (response.status === 401) { onUnauthorized(); onClose(); return; }
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not save the series. Please try again.");
      onSaved(data.book);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check your connection and try again.");
    } finally { setBusy(false); }
  }

  return <dialog ref={dialogRef} className="shelf-dialog shelf-series-dialog" aria-labelledby="series-dialog-title" aria-describedby="series-dialog-description"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={event => { if (!busy && isDialogBackdropClick(event)) onClose(); }}>
    <form onSubmit={submit}>
      <button className="shelf-icon-button shelf-dialog-close" type="button" aria-label="Close dialog" onClick={onClose} disabled={busy}><X size={21} /></button>
      <h2 id="series-dialog-title">Edit series</h2>
      <p id="series-dialog-description">Choose a series for “{book.title}”. Leave the series name blank to show this book on its own.</p>
      <label className="shelf-field-label">Series name<input autoFocus list="shelf-series-names" value={name} onChange={event => setName(event.target.value)} maxLength={200} disabled={busy} autoComplete="off" /></label>
      <datalist id="shelf-series-names">{seriesNames.map(title => <option key={title} value={title} />)}</datalist>
      <div className="shelf-series-fields">
        <div className="shelf-field-label"><label htmlFor="series-numbering">Numbering</label><select id="series-numbering" value={type} onChange={event => setType(event.target.value as "volume" | "chapter")} disabled={busy || !name.trim()}><option value="volume">Volumes</option><option value="chapter">Chapters</option></select></div>
        <label className="shelf-field-label">Volume or chapter number<input type="number" inputMode="decimal" min="0" step="any" value={number} onChange={event => setNumber(event.target.value)} disabled={busy || !name.trim()} aria-describedby="series-number-help" /></label>
      </div>
      <p id="series-number-help" className="shelf-field-help">Leave the number blank for a special. Numbered books appear first.</p>
      {error && <p className="shelf-form-error" role="alert"><CircleAlert size={16} />{error}</p>}
      <div className="shelf-dialog-actions">
        <button type="button" className="shelf-button shelf-button-light" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="shelf-button shelf-button-primary" disabled={busy}>{busy && <LoaderCircle size={16} className="shelf-spin" />}Save</button>
      </div>
    </form>
  </dialog>;
}
