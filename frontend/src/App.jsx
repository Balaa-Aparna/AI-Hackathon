import { useState, useRef } from "react";
import { marked } from "marked";

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
  const [message, setMessage] = useState("");
  const [relatedLinks, setRelatedLinks] = useState(null);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState("");
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

  async function handleSend() {
    const trimmed = message.trim();
    if (!trimmed) return;
    setMessage("");
    setRelatedLinks(null);
    setLinksError("");
    setLinksLoading(true);
    try {
      const res = await fetch("/api/related-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? `HTTP ${res.status}`);
      setRelatedLinks(data.results ?? []);
    } catch (err) {
      setLinksError(err.message);
    } finally {
      setLinksLoading(false);
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

      <div className="controls" style={{ alignItems: "flex-end" }}>
        <textarea
          placeholder="Type a message…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          style={{ flex: 1, resize: "vertical" }}
        />
        <button onClick={handleSend}>Send</button>
      </div>

      <div className="controls">
        <select value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="full">Full Article</option>
          <option value="auto">Auto Chunk (Sub-headings)</option>
        </select>
        <button onClick={render}>Retrieve the Content</button>
      </div>

      {linksLoading && <p className="muted">Searching for related links…</p>}
      {linksError && <p style={{ color: "red" }}>Related links error: {linksError}</p>}
      {relatedLinks !== null && (
        <div className="related-links">
          <h3>Related Links</h3>
          {relatedLinks.length === 0 ? (
            <p className="muted">No results found.</p>
          ) : (
            <ul>
              {relatedLinks.map((link, i) => (
                <li key={i}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.title || link.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

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