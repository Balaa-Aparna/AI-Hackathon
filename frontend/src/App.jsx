import { useState, useRef } from "react";
import { marked } from "marked";
import { fetchUrl } from "./api";

function slugify(text) {
  return text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

function parseWithAnchors(md) {
  const renderer = new marked.Renderer();
  renderer.heading = ({ text, depth }) => {
    const id = slugify(text);
    return `<h${depth} id="${id}"><a class="anchor-hash" href="#${id}">#</a> ${text}</h${depth}>`;
  };
  return marked.parse(md, { renderer });
}

export default function App() {
  const [rawMarkdown, setRawMarkdown] = useState("");
  const [sections, setSections] = useState([]);
  const [mode, setMode] = useState("full");
  const [rendered, setRendered] = useState(null);
  const [error, setError] = useState("");
  const [anchoredChunks, setAnchoredChunks] = useState(new Map());
  const [url, setUrl] = useState("");
  const [loadingUrl, setLoadingUrl] = useState(false);
  const fileInputRef = useRef(null);

  function chunkBySubHeadings(md) {
    const lines = md.split("\n");
    const chunks = [];
    let current = [];

    lines.forEach((line) => {
      if (/^#{1,2}\s+/.test(line)) {
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

  async function handleUrl() {
    const trimmed = url.trim();
    if (!trimmed) return;

    setError("");
    setLoadingUrl(true);
    try {
      const doc = await fetchUrl(trimmed);
      // Treat the fetched page text as the source content.
      setRawMarkdown(doc.text);
      setSections(chunkBySubHeadings(doc.text));
      setRendered(null);
    } catch (err) {
      setError(err.message);
      setRendered(null);
    } finally {
      setLoadingUrl(false);
    }
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

      <p className="muted" style={{ textAlign: "left", margin: "0.5rem 0" }}>
        — or —
      </p>

      <div className="controls">
        <input
          type="text"
          placeholder="Paste a link (https://…)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleUrl()}
          style={{ flex: 1, minWidth: "240px" }}
        />
        <button onClick={handleUrl} disabled={loadingUrl}>
          {loadingUrl ? "Fetching…" : "Fetch from URL"}
        </button>
      </div>

      <div className="controls">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="full">Full Article</option>
          <option value="auto">Auto Chunk (Sub-headings)</option>
        </select>
        <button onClick={render}>Retrieve the Content</button>
      </div>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <div className="viewer">
        {rendered === null ? (
          <p className="muted">Upload a file...</p>
        ) : (
          rendered.map((sec, i) => {
            const hasAnchors = anchoredChunks.has(i);
            const anchors = anchoredChunks.get(i);
            return (
              <div key={i} className="chunk">
                <div dangerouslySetInnerHTML={{ __html: hasAnchors ? parseWithAnchors(sec) : marked.parse(sec) }} />
                {mode === "auto" && (
                  <div className="chunk-actions">
                    {!hasAnchors ? (
                      <button
                        className="anchor-btn"
                        onClick={async () => {
                          setAnchoredChunks(prev => new Map([...prev, [i, null]]));
                          try {
                            const res = await fetch("/api/anchors", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ text: sec }),
                            });
                            const data = await res.json();
                            if (!res.ok) throw new Error(data.detail ?? `HTTP ${res.status}`);
                            setAnchoredChunks(prev => new Map([...prev, [i, data.anchors ?? []]]));
                          } catch (err) {
                            setAnchoredChunks(prev => new Map([...prev, [i, [`Error: ${err.message}`]]]));
                          }
                        }}
                      >
                        Create Anchors
                      </button>
                    ) : anchors === null ? (
                      <span className="anchor-label">Extracting anchors…</span>
                    ) : (
                      <div className="anchor-list">
                        <span className="anchor-label">Anchors:</span>
                        {anchors.map((a, j) => (
                          <span key={j} className="anchor-tag">{a}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </main>
  );
}