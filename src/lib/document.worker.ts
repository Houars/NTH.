import { chunkPages, MAX_DOCUMENT_CHARS, retrieveChunks, type DocumentPage, type StoredDocument } from "./documents";

self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer; pdf: boolean; task?: string; documents: StoredDocument[]; question: string; recent: string; budget: number }>) => {
  try {
    if (event.data.task === "retrieve") {
      const selection = retrieveChunks(event.data.documents, event.data.question, event.data.recent, event.data.budget).map(item => ({ id: item.document.id, index: item.chunk.index }));
      self.postMessage({ nthDocument: true, selection });
      return;
    }
    const pages: DocumentPage[] = [];
    let warning = "";
    if (event.data.pdf) {
      const pdfjs = await import("pdfjs-dist");
      const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      // PDF.js runs its parser in this already-isolated worker. Text extraction
      // never renders pages or executes PDF JavaScript/actions/attachments.
      const task = pdfjs.getDocument({
        data: new Uint8Array(event.data.buffer), useSystemFonts: false, disableFontFace: true, useWorkerFetch: true,
        cMapUrl: new URL("/pdf-assets/cmaps/", self.location.origin).href,
        standardFontDataUrl: new URL("/pdf-assets/standard_fonts/", self.location.origin).href
      });
      try {
        const pdf = await task.promise;
        if (pdf.numPages > 500) throw new Error("Use a PDF with no more than 500 pages, or attach a smaller section.");
        let total = 0, blank = 0;
        for (let page = 1; page <= pdf.numPages; page++) {
          const source = await pdf.getPage(page);
          const content = await source.getTextContent();
          const text = content.items.map(item => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("").trim();
          total += text.length;
          if (total > MAX_DOCUMENT_CHARS) throw new Error("This document has too much text. Attach a section under 240,000 characters.");
          if (!text) blank++;
          pages.push({ page, text });
          source.cleanup();
        }
        if (!total) throw new Error("This PDF has no embedded text. Scanned/image-only PDFs need OCR, which NTH does not support yet.");
        if (blank) warning = `${blank} page(s) contain no embedded text. Images and scanned content are not read.`;
      } finally { await task.destroy(); }
    } else {
      const bytes = new Uint8Array(event.data.buffer);
      const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
      let text: string;
      try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
      catch { throw new Error("This text encoding is unsupported. Save the file as UTF-8, then attach it again."); }
      if (text.includes("\0")) throw new Error("That file contains binary data. Use a plain-text file.");
      if (!text.trim()) throw new Error("That file is empty. Choose a file with text.");
      if (text.length > MAX_DOCUMENT_CHARS) throw new Error("This document has too much text. Attach a section under 240,000 characters.");
      pages.push({ page: 1, text });
    }
    self.postMessage({ nthDocument: true, pages, chunks: chunkPages(pages), warning });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : "";
    self.postMessage({ nthDocument: true, error: name === "PasswordException" ? "This PDF is password-protected. Attach an unlocked copy."
      : /^(Use a PDF|This document|This PDF has no|This text encoding|That file)/.test(message) ? message
      : "That PDF is corrupt or could not be read. Export a fresh PDF with embedded text and try again." });
  }
};
