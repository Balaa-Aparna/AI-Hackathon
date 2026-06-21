import { useState, useEffect } from "react";
import { marked } from "marked";

const MAX_PROMPT = 200;

const STEPS = [
  { id: 1, name: "Anchor" },
  { id: 2, name: "Extract" },
  { id: 3, name: "Explore" },
  { id: 4, name: "Compose" },
];

const STEP_HEADER = {
  1: {
    eyebrow: "Step 1 · Question",
    title: <>Read deeper. <em>Explore further.</em></>,
    lede:
      "Describe what you're researching. AnchorPoint searches the web and brings back the sources worth following.",
  },
  2: {
    eyebrow: "Step 2 · Sources",
    title: <>Four links <em>worth following.</em></>,
    lede:
      "These are the server-rendered sources we found. Retrieve their content to read and break it into chunks.",
  },
  3: {
    eyebrow: "Step 3 · Explore the Focused Ideas, Edit the Focus",
    title: <>Read, chunk, <em>anchor.</em></>,
    lede:
      "Switch between sources, edit any chunk in its side panel, and drop anchors on the ideas that hold it together.",
  },
  4: {
    eyebrow: "Step 4 · Compose",
    title: <>Your voice. <em>Real sources.</em></>,
    lede:
      "Tell the agent what you want to achieve and what you genuinely think. It will pull the most relevant anchors and write a post grounded in real information.",
  },
};

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

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export default function App() {
  const [step, setStep] = useState(1);

  // Step 1
  const [message, setMessage] = useState("");
  const [relatedLinks, setRelatedLinks] = useState(null);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState("");

  // Step 3
  const [activeLink, setActiveLink] = useState(0);
  // { [linkIdx]: { status: "loading"|"ready"|"error", chunks: string[], error } }
  const [linkContent, setLinkContent] = useState({});
  // anchors (editable): key `${linkIdx}:${chunkIdx}` -> string[] | null (loading)
  const [anchoredChunks, setAnchoredChunks] = useState({});

  // Step 4
  const [goal, setGoal] = useState("");
  const [opinion, setOpinion] = useState("");
  const [postMode, setPostMode] = useState("auto");
  const [postResult, setPostResult] = useState(null);
  const [postLoading, setPostLoading] = useState(false);
  const [postError, setPostError] = useState("");
  const [copied, setCopied] = useState(false);

  const canStep2 = relatedLinks !== null;
  const canStep3 = relatedLinks !== null && relatedLinks.length > 0;
  const canStep4 = Object.values(anchoredChunks).some((a) => Array.isArray(a) && a.length > 0);

  function goToStep(id) {
    if (id === 2 && !canStep2) return;
    if (id === 3 && !canStep3) return;
    if (id === 4 && !canStep4) return;
    setStep(id);
  }

  async function handleSend() {
    const trimmed = message.trim();
    if (!trimmed) return;
    setLinksError("");
    setLinksLoading(true);
    setRelatedLinks(null);
    setLinkContent({});
    setAnchoredChunks({});
    setActiveLink(0);
    try {
      const res = await fetch("/api/related-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? `HTTP ${res.status}`);
      setRelatedLinks(data.results ?? []);
      setStep(2);
    } catch (err) {
      setLinksError(err.message);
    } finally {
      setLinksLoading(false);
    }
  }

  // Fetch + chunk a link's page on demand (cached after first load).
  async function loadLink(idx) {
    const link = relatedLinks?.[idx];
    if (!link) return;
    setLinkContent((prev) => {
      if (prev[idx]?.status === "loading" || prev[idx]?.status === "ready") return prev;
      return { ...prev, [idx]: { status: "loading", chunks: [] } };
    });

    try {
      const res = await fetch("/api/fetch-markdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: link.url }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const md = await res.text();
      setLinkContent((prev) => ({
        ...prev,
        [idx]: { status: "ready", chunks: chunkBySubHeadings(md) },
      }));
    } catch (err) {
      setLinkContent((prev) => ({
        ...prev,
        [idx]: { status: "error", chunks: [], error: err.message },
      }));
    }
  }

  // Load the active source's content whenever we're on Step 3.
  useEffect(() => {
    if (step === 3 && relatedLinks?.length) {
      const existing = linkContent[activeLink]?.status;
      if (existing !== "ready" && existing !== "loading") loadLink(activeLink);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, activeLink, relatedLinks]);

  async function createAnchors(idx, ci) {
    const key = `${idx}:${ci}`;
    const text = linkContent[idx]?.chunks[ci] ?? "";
    setAnchoredChunks((prev) => ({ ...prev, [key]: null }));
    try {
      const res = await fetch("/api/anchors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? `HTTP ${res.status}`);
      setAnchoredChunks((prev) => ({ ...prev, [key]: data.anchors ?? [] }));
    } catch (err) {
      setAnchoredChunks((prev) => ({ ...prev, [key]: [`Error: ${err.message}`] }));
    }
  }

  // Edit anchors in the Step 3 side panel.
  function setAnchor(key, j, value) {
    setAnchoredChunks((prev) => {
      const list = [...(prev[key] || [])];
      list[j] = value;
      return { ...prev, [key]: list };
    });
  }

  function removeAnchor(key, j) {
    setAnchoredChunks((prev) => ({
      ...prev,
      [key]: (prev[key] || []).filter((_, idx) => idx !== j),
    }));
  }

  function addAnchor(key) {
    setAnchoredChunks((prev) => ({ ...prev, [key]: [...(prev[key] || []), ""] }));
  }

  async function handleGeneratePost() {
    setPostError("");
    setPostResult(null);
    setPostLoading(true);
    setCopied(false);
    try {
      const res = await fetch("/api/generate-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: goal.trim(), opinion: opinion.trim(), mode: postMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? `HTTP ${res.status}`);
      setPostResult(data);
    } catch (err) {
      setPostError(err.message);
    } finally {
      setPostLoading(false);
    }
  }

  function copyPost() {
    if (!postResult?.post) return;
    navigator.clipboard.writeText(postResult.post).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const header = STEP_HEADER[step];

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="5" r="2" />
              <line x1="12" y1="7" x2="12" y2="22" />
              <path d="M5 12H2a10 10 0 0 0 20 0h-3" />
            </svg>
          </span>
          <span className="brand-name">AnchorPoint</span>
        </div>
        <nav className="nav">
          <a href="#">How it works</a>
          <a href="#">Examples</a>
          <a href="#">About</a>
        </nav>
      </header>

      <ol className="steps">
        {STEPS.map((s) => {
          const locked =
            (s.id === 2 && !canStep2) ||
            (s.id === 3 && !canStep3) ||
            (s.id === 4 && !canStep4);
          return (
            <li
              key={s.id}
              className={`step${step === s.id ? " active" : ""}${locked ? " locked" : ""}`}
              onClick={() => goToStep(s.id)}
              role="button"
              tabIndex={locked ? -1 : 0}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && goToStep(s.id)}
            >
              <span className="step-num">{s.id}</span> {s.name}
            </li>
          );
        })}
      </ol>

      <main className="container">
        <section className="panel">
          <p className="eyebrow">{header.eyebrow}</p>
          <h1 className="hero">{header.title}</h1>
          <p className="lede">{header.lede}</p>

          {/* ---------- STEP 1: prompt ---------- */}
          {step === 1 && (
            <>
              <div className="controls" style={{ alignItems: "flex-end" }}>
                <textarea
                  placeholder="What do you want to explore? (e.g., 'What is the Future of AI in Education?')"
                  value={message}
                  onChange={(e) => setMessage(e.target.value.slice(0, MAX_PROMPT))}
                  maxLength={MAX_PROMPT}
                  rows={3}
                  style={{ flex: 1 }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
                  }}
                />
                <button onClick={handleSend} disabled={linksLoading || !message.trim()}>
                  {linksLoading ? "Searching…" : "Sent"}
                </button>
              </div>
              <div className="char-count">
                {message.length}/{MAX_PROMPT}
              </div>
              {linksError && <p className="error-text">Related links error: {linksError}</p>}
            </>
          )}

          {/* ---------- STEP 2: sources ---------- */}
          {step === 2 && (
            <>
              {relatedLinks && relatedLinks.length > 0 ? (
                <ul className="source-list">
                  {relatedLinks.map((link, i) => (
                    <li key={i} className="source-card">
                      <span className="source-index">{i + 1}</span>
                      <div className="source-body">
                        <a href={link.url} target="_blank" rel="noopener noreferrer" className="source-title">
                          {link.title || link.url}
                        </a>
                        <span className="source-host">{hostOf(link.url)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No sources found. Go back to Step 1 and try another prompt.</p>
              )}

              <div className="controls">
                <button onClick={() => goToStep(1)} className="ghost-btn">← Back</button>
                <button onClick={() => goToStep(3)} disabled={!canStep3}>
                  Retrieve the Content
                </button>
              </div>
            </>
          )}

          {/* ---------- STEP 3: explore ---------- */}
          {step === 3 && relatedLinks && (
            <>
              <div className="link-tabs">
                {relatedLinks.map((link, i) => (
                  <button
                    key={i}
                    className={`link-tab${activeLink === i ? " active" : ""}`}
                    onClick={() => setActiveLink(i)}
                    title={link.title || link.url}
                  >
                    <span className="link-tab-num">{i + 1}</span>
                    {hostOf(link.url)}
                  </button>
                ))}
              </div>

              {(() => {
                const content = linkContent[activeLink];
                if (!content || content.status === "loading") {
                  return <p className="muted">Fetching &amp; chunking this source…</p>;
                }
                if (content.status === "error") {
                  return (
                    <p className="error-text">
                      Couldn't load this source: {content.error}
                    </p>
                  );
                }
                if (!content.chunks.length) {
                  return <p className="muted">No content found for this source.</p>;
                }
                return (
                  <div className="viewer">
                    {content.chunks.map((text, ci) => {
                      const key = `${activeLink}:${ci}`;
                      const anchors = anchoredChunks[key];
                      const hasAnchors = key in anchoredChunks;
                      return (
                        <div key={ci} className="chunk-row">
                          <div className="chunk">
                            <div
                              dangerouslySetInnerHTML={{
                                __html: hasAnchors && anchors ? parseWithAnchors(text) : marked.parse(text),
                              }}
                            />
                            <div className="chunk-actions">
                              {!hasAnchors ? (
                                <button className="anchor-btn" onClick={() => createAnchors(activeLink, ci)}>
                                  Create Anchors
                                </button>
                              ) : anchors === null ? (
                                <span className="anchor-label">Extracting anchors…</span>
                              ) : (
                                <div className="anchor-list">
                                  <span className="anchor-label">Anchors:</span>
                                  {anchors.map((a, j) => (
                                    <span key={j} className="anchor-tag">{a || "—"}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>

                          <aside className="chunk-editor">
                            <label className="anchor-label">Edit anchors</label>
                            {!hasAnchors ? (
                              <p className="muted anchor-hint">
                                Create anchors to edit them here.
                              </p>
                            ) : anchors === null ? (
                              <span className="anchor-label">Extracting anchors…</span>
                            ) : (
                              <div className="anchor-edit-list">
                                {anchors.map((a, j) => (
                                  <div key={j} className="anchor-edit-row">
                                    <input
                                      type="text"
                                      value={a}
                                      placeholder="Anchor phrase"
                                      onChange={(e) => setAnchor(key, j, e.target.value)}
                                    />
                                    <button
                                      type="button"
                                      className="anchor-remove"
                                      aria-label="Remove anchor"
                                      onClick={() => removeAnchor(key, j)}
                                    >
                                      ×
                                    </button>
                                  </div>
                                ))}
                                <button
                                  type="button"
                                  className="ghost-btn anchor-add"
                                  onClick={() => addAnchor(key)}
                                >
                                  + Add anchor
                                </button>
                              </div>
                            )}
                          </aside>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              <div className="controls">
                <button onClick={() => goToStep(2)} className="ghost-btn">← Sources</button>
                {canStep4 && (
                  <button onClick={() => goToStep(4)}>Compose Post →</button>
                )}
              </div>
            </>
          )}

          {/* ---------- STEP 4: compose ---------- */}
          {step === 4 && (
            <>
              <div className="compose-form">
                <label className="anchor-label" htmlFor="goal-input">
                  What do you want to achieve with this?
                </label>
                <textarea
                  id="goal-input"
                  placeholder="e.g. Spark a conversation about AI and education policy"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  rows={3}
                />

                <label className="anchor-label" htmlFor="opinion-input">
                  What do you genuinely think about it?
                </label>
                <textarea
                  id="opinion-input"
                  placeholder="e.g. I think the hype is outrunning the evidence, and teachers are being left behind"
                  value={opinion}
                  onChange={(e) => setOpinion(e.target.value)}
                  rows={3}
                />

                <div className="mode-row">
                  <span className="anchor-label">Anchor pattern:</span>
                  {["auto", "theme", "tension", "outlier"].map((m) => (
                    <button
                      key={m}
                      className={`mode-btn${postMode === m ? " active" : ""}`}
                      onClick={() => setPostMode(m)}
                      type="button"
                    >
                      {m.charAt(0).toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="controls">
                <button onClick={() => goToStep(3)} className="ghost-btn">← Explore</button>
                <button
                  onClick={handleGeneratePost}
                  disabled={postLoading || !goal.trim() || !opinion.trim()}
                >
                  {postLoading ? "Generating…" : "Generate Post"}
                </button>
              </div>

              {postError && <p className="error-text">{postError}</p>}

              {postResult && (
                <div className="post-result">
                  <div className="post-meta">
                    <span className="anchor-label">Pattern used:</span>{" "}
                    <span className="anchor-tag">{postResult.mode_used}</span>
                  </div>

                  <div className="post-body">
                    {postResult.post.split("\n\n").map((para, i) => (
                      <p key={i}>{para}</p>
                    ))}
                  </div>

                  <button className="ghost-btn copy-btn" onClick={copyPost}>
                    {copied ? "Copied!" : "Copy post"}
                  </button>

                  {postResult.anchors_used?.length > 0 && (
                    <details className="anchors-used">
                      <summary className="anchor-label">Sources used ({postResult.anchors_used.length} anchors)</summary>
                      <ul>
                        {postResult.anchors_used.map((a, i) => (
                          <li key={i} className="muted">{a}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </>
  );
}
