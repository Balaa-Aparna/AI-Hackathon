// Thin API client. Requests are proxied to the FastAPI backend (see vite.config.js).

export async function listDocuments() {
  const res = await fetch("/api/documents");
  if (!res.ok) throw new Error("Failed to load documents");
  return res.json();
}

export async function uploadDocument(file) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/upload", { method: "POST", body: form });
  if (!res.ok) throw new Error("Upload failed");
  return res.json();
}

export async function sendPrompt(prompt, documentId) {
  const res = await fetch("/api/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, document_id: documentId || null }),
  });
  if (!res.ok) throw new Error("Prompt failed");
  return res.json();
}
