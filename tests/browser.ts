// Development-only UI harness. Not included in the production Vite entry.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { MODEL_BY_MODE } from "../src/lib/nth";

const pending: Array<() => void> = [];
mockWindows("main");
mockIPC((command, payload: any) => {
  if (command === "ollama_health") return { reachable: true, modelInstalled: true, expectedModel: MODEL_BY_MODE.RUN, installedModels: [MODEL_BY_MODE.RUN] };
  if (command === "ollama_chat_stream") {
    const files = [...new Set((payload.policy.match(/\[[^\]\n]+\.(?:txt|md|pdf)(?: · pp?\. [^\]]+)?\]/g) || []))];
    transport.textContent = `MOCK MODEL · ${files.length ? "FILE evidence received: " + files.join(" / ") : "No FILE evidence"}`;
    return new Promise(resolve => pending.push(() => resolve({ content: payload.policy.includes("Marcus Vale") ? "Marcus Vale leads Blackbird. [blackbird.txt]" : "The recommendation is 32 GB VRAM. [gpu-notes.pdf · p. 2]" })));
  }
  if (command === "cancel_operation") { pending.splice(0).forEach(resolve => resolve()); return; }
  if (command === "plugin:app|version") return "0.6.1-test";
  return false;
});
await import("../src/main");
function pdf(blank = false): File {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const text of ["GPU notes introduction.", "Recommendation: RTX 5090 with 32 GB VRAM."]) {
    const stream = blank ? "" : `BT /F1 14 Tf 40 750 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new File([body], blank ? "scanned.pdf" : "gpu-notes.pdf", { type: "application/pdf" });
}
const toolbar = document.createElement("div");
toolbar.style.cssText = "position:fixed;top:51px;left:260px;z-index:500;display:flex;gap:8px;font-size:10px";
function control(label: string, action: () => void) { const button = document.createElement("button"); button.textContent = label; button.onclick = action; toolbar.append(button); }
function drop(file: File) { const transfer = new DataTransfer(); transfer.items.add(file); document.querySelector(".app")!.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer })); }
control("Fixture PDF", () => drop(pdf()));
control("Fixture text", () => drop(new File(["GPU notes\nRecommended memory: 32 GB.\nBudget: 1200 EUR."], "notes.md", { type: "text/markdown" })));
control("Fixture corrupt", () => drop(new File(["corrupt"], "bad.pdf", { type: "application/pdf" })));
control("Fixture scanned", () => drop(pdf(true)));
control("Complete reply", () => pending.shift()?.());
document.addEventListener("keydown", event => { if (event.key === "F8") { event.preventDefault(); pending.shift()?.(); } });
document.body.append(toolbar);
const transport = document.createElement("output");
transport.setAttribute("aria-label", "Model transport inspection");
transport.style.cssText = "position:fixed;top:82px;left:260px;z-index:500;font-size:10px;color:#aaa;max-width:65vw";
document.body.append(transport);
