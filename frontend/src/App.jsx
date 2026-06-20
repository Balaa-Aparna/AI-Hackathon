import { useState, useRef } from "react";
import { marked } from "marked";

export default function App() {
  const [rawMarkdown, setRawMarkdown] = useState("");
  const [sections, setSections] = useState([]);
  const [mode, setMode] = useState("full");
  const [rendered, setRendered] = useState(null);
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  function chunkBySubHeadings(md) {
    const lines = md.split("\n");
    const chunks = [];
    let current = [];

    lines.forEach((line) => {
      if (/^##\s+/.test(line)) {
        if (current.length) {
          chunks.push(current.join("\n"));
          current = [];
        }
      }
      current.push(line);
    });

    if (current.length) chunks.push(current.join("\n"));
    return chunks;
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().match(/\.(md|markdown)$/)) {
      setError("Only Markdown files allowed.");
      setRendered(null);
      return;
    }

    setError("");
    const reader = new FileReader();
    reader.onload = (ev) => {
      const md = ev.target.result;
      setRawMarkdown(md);
      setSections(chunkBySubHeadings(md));
      setRendered(null);
    };
    reader.readAsText(file);
  }

  function render() {
    if (!rawMarkdown) return;

    if (mode === "full") {
      setRendered([rawMarkdown]);
    } else {
      setRendered(sections);
    }
  }

  return (
    <main className="container">
      <h1>Source Viewer</h1>

      <input
        ref={fileInputRef}
        type="file"
        accept=".md,.markdown"
        onChange={handleFile}
      />

      <div className="controls">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="full">Full Article</option>
          <option value="auto">Auto Chunk (Sub-headings)</option>
        </select>
        <button onClick={render}>Render</button>
      </div>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <div className="viewer">
        {rendered === null ? (
          <p className="muted">Upload a Markdown file...</p>
        ) : (
          rendered.map((sec, i) => (
            <div
              key={i}
              className="chunk"
              dangerouslySetInnerHTML={{ __html: marked.parse(sec) }}
            />
          ))
        )}
      </div>
    </main>
  );
}