import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { StoredDocument } from "../lib/documents";

export function DocumentReader({ document, initialPage, onClose }: { document: StoredDocument; initialPage: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(Math.max(1, Math.min(document.pages.length, initialPage)));
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="document-reader" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header><div><strong>{document.name}</strong><small>LOCAL COPY · EXTRACTED TEXT</small></div><button autoFocus onClick={onClose} aria-label="Close document"><X size={17} /></button></header>
    {document.warning && <p className="document-warning">{document.warning}</p>}
    <pre key={page}>{document.pages[page - 1]?.text || "No embedded text on this page. Images are not analyzed."}</pre>
    <footer><span>Page {page} of {document.pages.length}</span><div>
      <button onClick={() => setPage(current => current - 1)} disabled={page === 1} aria-label="Previous page"><ChevronLeft size={16} /></button>
      <button onClick={() => setPage(current => current + 1)} disabled={page === document.pages.length} aria-label="Next page"><ChevronRight size={16} /></button>
    </div></footer>
  </dialog>;
}
