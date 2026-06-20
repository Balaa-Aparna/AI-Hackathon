import { useEffect, useState } from "react";
import { listDocuments, uploadDocument, sendPrompt, getDocument } from "./api";
import DocumentPage from "./DocumentPage.jsx";

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    refreshDocuments();
  }, []);

  async function refreshDocuments() {
    try {
      setDocuments(await listDocuments());
    } catch (err) {
      setStatus(err.message);
    }
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setStatus("Uploading…");
    try {
      const doc = await uploadDocument(file);
      setStatus(`Uploaded ${doc.name}`);
      setSelectedId(doc.id);
      await refreshDocuments();
    } catch (err) {
      setStatus(err.message);
    } finally {
      e.target.value = "";
    }
  }

  async function handleAsk(e) {
    e.preventDefault();
    if (!prompt.trim()) return;
    if (!selectedId) {
      setStatus("Select a document first.");
      return;
    }
    setStatus("Thinking…");
    setAnswer("");
    try {
      const [res, document] = await Promise.all([
        sendPrompt(prompt, selectedId),
        getDocument(selectedId),
      ]);
      setAnswer(res.answer);
      setStatus("");
      setResult({ document, answer: res.answer, prompt });
    } catch (err) {
      setStatus(err.message);
    }
  }

  if (result) {
    return (
      <DocumentPage
        document={result.document}
        answer={result.answer}
        prompt={result.prompt}
        onBack={() => setResult(null)}
      />
    );
  }

  return (
    <main className="container">
      <h1>Doc Prompt</h1>

      <section className="card">
        <h2>1. Upload a document</h2>
        <input type="file" onChange={handleUpload} />
        <ul className="doc-list">
          {documents.map((doc) => (
            <li key={doc.id}>
              <label>
                <input
                  type="radio"
                  name="doc"
                  value={doc.id}
                  checked={selectedId === doc.id}
                  onChange={() => setSelectedId(doc.id)}
                />
                {doc.name}
              </label>
            </li>
          ))}
          {documents.length === 0 && <li className="muted">No documents yet.</li>}
        </ul>
      </section>

      <section className="card">
        <h2>2. Ask a question</h2>
        <form onSubmit={handleAsk}>
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask something about the selected document…"
          />
          <button type="submit">Send</button>
        </form>
        {answer && <pre className="answer">{answer}</pre>}
      </section>

      {status && <p className="status">{status}</p>}
    </main>
  );
}
