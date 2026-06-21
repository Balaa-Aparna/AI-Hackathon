import { useState, useEffect } from "react";
import { marked } from "marked";
import { flushSync } from "react-dom";
import { MicButton, SpeakButton, appendSpoken, stripMarkdown } from "./voice.jsx";

const MAX_PROMPT = 200;

const ANCHOR_HUES = [18, 38, 85, 200, 270, 330, 160, 50];

function injectHighlights(md, anchors) {
  if (!Array.isArray(anchors) || !anchors.length) return md;
  let result = md;
  anchors.forEach((anchor, i) => {
    const quote = anchor?.quote;
    if (!quote || !quote.trim()) return;
    const hue = ANCHOR_HUES[i % ANCHOR_HUES.length];
    const escaped = quote.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
      result = result.replace(
        new RegExp(escaped),
        `<mark class="anchor-mark" data-ai="${i}" style="--mark-hue:${hue}">$&</mark>`
      );
    } catch {}
  });
  return result;
}

const STEPS = [
  { id: 1, name: "Anchor" },
  { id: 2, name: "Extract" },
  { id: 3, name: "Explore" },
  { id: 4, name: "Review" },
  { id: 5, name: "Reflect" },
  { id: 6, name: "Post" },
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
      "These are the sources we found. Retrieve their content to read and break it into chunks.",
  },
  3: {
    eyebrow: "Step 3 · Explore the Focused Ideas, Edit the Focus",
    title: <>Read, chunk, <em>anchor.</em></>,
    lede:
      "Switch between sources, edit any chunk in its side panel, and drop anchors on the ideas that hold it together.",
  },
  4: {
    eyebrow: "Step 4 · Your Anchors",
    title: <>Everything you <em>anchored.</em></>,
    lede:
      "All the ideas you marked across every source, collected in one place.",
  },
  5: {
    eyebrow: "Step 5 · Reflect",
    title: <>Your take. <em>Be honest.</em></>,
    lede:
      "One question — share your genuine perspective before generating.",
  },
  6: {
    eyebrow: "Step 6 · Your Post",
    title: <>Ready to <em>share.</em></>,
    lede:
      "Your research, your anchors, your take — distilled into one post.",
  },
};

function slugify(text) {
  return text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
}

const noImgRenderer = new marked.Renderer();
noImgRenderer.image = () => "";

// Renderer for the long-form article: drop images and open citation links in a
// new tab so users keep their place in the app.
const articleRenderer = new marked.Renderer();
articleRenderer.image = () => "";
articleRenderer.link = ({ href, title, text }) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer"${title ? ` title="${title}"` : ""}>${text}</a>`;

function parseWithAnchors(md) {
  const renderer = new marked.Renderer();
  renderer.image = () => "";
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

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Reusable hover preview card for a source link (thumbnail + host + date).
function LinkPreview({ link }) {
  const date = formatDate(link.published);
  const hide = (e) => { e.currentTarget.style.display = "none"; };
  return (
    <div className="link-preview" role="tooltip">
      {link.image && (
        <img className="link-preview-img" src={link.image} alt="" loading="lazy" onError={hide} />
      )}
      <div className="link-preview-body">
        <span className="link-preview-title">{link.title || link.url}</span>
        <span className="link-preview-meta">
          {link.favicon && (
            <img className="link-preview-favicon" src={link.favicon} alt="" onError={hide} />
          )}
          <span>{hostOf(link.url)}{date ? ` · ${date}` : ""}</span>
        </span>
      </div>
    </div>
  );
}

export default function App() {
  const [step, setStep] = useState(1);
  const [modal, setModal] = useState(null); // null | "how" | "about"
  const [selectionPopover, setSelectionPopover] = useState(null); // {text, key, top, left}

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

  // Step 5
  const [achieve, setAchieve] = useState("");
  const [opinion, setOpinion] = useState("");

  // Step 6
  const [generatedPost, setGeneratedPost] = useState("");
  const [postFormat, setPostFormat] = useState("post"); // "post" | "article"
  const [postLoading, setPostLoading] = useState(false);
  const [postError, setPostError] = useState("");
  const [copied, setCopied] = useState(false);

  const canStep2 = relatedLinks !== null;
  const canStep3 = relatedLinks !== null && relatedLinks.length > 0;
  const canStep4 = canStep3;
  const canStep5 = canStep4;
  const canStep6 = !!generatedPost;

  // Credit line for the final post: author names when available, else the
  // short-form source host (e.g. "journals.plos.org"). Deduplicated.
  const credit = relatedLinks?.length
    ? "credit: " +
    [...new Set(relatedLinks.map((l) => l.author || hostOf(l.url)).filter(Boolean))].join(", ")
    : "";

  // Cross-fade between step views via the View Transitions API. Falls back to an
  // instant swap where unsupported or when the user prefers reduced motion.
  function changeStep(next) {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce && typeof document !== "undefined" && document.startViewTransition) {
      document.startViewTransition(() => flushSync(() => setStep(next)));
    } else {
      setStep(next);
    }
  }

  function goToStep(id) {
    if (id === 2 && !canStep2) return;
    if (id === 3 && !canStep3) return;
    if (id === 4 && !canStep4) return;
    if (id === 5 && !canStep5) return;
    if (id === 6 && !canStep6) return;
    changeStep(id);
  }

  async function handleFinalize(fmt = postFormat) {
    setPostError("");
    setPostLoading(true);
    setGeneratedPost("");
    setCopied(false);
    setPostFormat(fmt);

    const allAnchors = [];
    Object.values(anchoredChunks).forEach((anchors) => {
      if (Array.isArray(anchors)) anchors.forEach((a) => {
        const phrase = a?.phrase ?? a;
        if (phrase) allAnchors.push(phrase);
      });
    });
    const sources = (relatedLinks ?? []).map((l) => ({ title: l.title || "", url: l.url }));

    try {
      const res = await fetch("/api/generate-post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: message, anchors: allAnchors, achieve, opinion, format: fmt, sources }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ?? `HTTP ${res.status}`);
      setGeneratedPost(data.post);
      changeStep(6);
    } catch (err) {
      setPostError(err.message);
    } finally {
      setPostLoading(false);
    }
  }

  function handleCopy() {
    // The article already ends with a Sources section, so only the short post
    // needs the credit line appended.
    const text =
      postFormat === "post" && credit ? `${generatedPost}\n\n${credit}` : generatedPost;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
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
      changeStep(2);
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
        body: JSON.stringify({ text, achieve }),
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
      list[j] = { ...list[j], phrase: value };
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
    setAnchoredChunks((prev) => ({ ...prev, [key]: [...(prev[key] || []), { phrase: "", quote: "" }] }));
  }

  function handleChunkMouseUp(key) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { setSelectionPopover(null); return; }
    const text = sel.toString().trim();
    if (!text) { setSelectionPopover(null); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelectionPopover({ text, key, top: rect.top + window.scrollY, left: rect.left + rect.width / 2 });
  }

  function addSelectionAsAnchor() {
    if (!selectionPopover) return;
    const { text, key } = selectionPopover;
    setAnchoredChunks((prev) => {
      const existing = Array.isArray(prev[key]) ? prev[key] : [];
      return { ...prev, [key]: [...existing, { phrase: text, quote: text }] };
    });
    setSelectionPopover(null);
    window.getSelection()?.removeAllRanges();
  }

  function deleteChunk(linkIdx, ci) {
    setLinkContent((prev) => {
      const content = prev[linkIdx];
      if (!content) return prev;
      return { ...prev, [linkIdx]: { ...content, chunks: content.chunks.filter((_, i) => i !== ci) } };
    });
    setAnchoredChunks((prev) => {
      const next = {};
      Object.entries(prev).forEach(([key, anchors]) => {
        const [kLink, kChunk] = key.split(":").map(Number);
        if (kLink !== linkIdx) { next[key] = anchors; return; }
        if (kChunk === ci) return; // deleted chunk's anchors — drop them
        if (kChunk > ci) next[`${kLink}:${kChunk - 1}`] = anchors;
        else next[key] = anchors;
      });
      return next;
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
          <button type="button" className="nav-link" onClick={() => setModal("how")}>How it works</button>
          <button type="button" className="nav-link" onClick={() => setModal("about")}>About</button>
        </nav>
      </header>

      <ol className="steps">
        {STEPS.map((s) => {
          const locked =
            (s.id === 2 && !canStep2) ||
            (s.id === 3 && !canStep3) ||
            (s.id === 4 && !canStep4) ||
            (s.id === 5 && !canStep5) ||
            (s.id === 6 && !canStep6);
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
          <div className="step-view">
            <p className="eyebrow">{header.eyebrow}</p>
            <h1 className="hero">{header.title}</h1>
            <p className="lede">{header.lede}</p>

            {/* ---------- STEP 1: prompt ---------- */}
            {step === 1 && (
              <>
                <div className="controls" style={{ alignItems: "flex-end" }}>
                  <div className="field-with-mic" style={{ flex: 1 }}>
                    <textarea
                      placeholder="What do you want to explore? (e.g., 'How to build a birdhouse?')"
                      value={message}
                      onChange={(e) => setMessage(e.target.value.slice(0, MAX_PROMPT))}
                      maxLength={MAX_PROMPT}
                      rows={3}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
                      }}
                    />
                    <MicButton
                      className="mic-in-field"
                      title="Dictate your question"
                      onResult={(t) => setMessage((m) => appendSpoken(m, t).slice(0, MAX_PROMPT))}
                    />
                  </div>
                  <button onClick={handleSend} disabled={linksLoading || !message.trim()}>
                    {linksLoading ? "Searching…" : "Sent"}
                  </button>
                </div>
                <div className="char-count">
                  {message.length}/{MAX_PROMPT}
                </div>
                <div className="reflect-field" style={{ marginTop: "1rem" }}>
                  <label className="reflect-label">What do you want to achieve with this? <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional — shapes which anchors get extracted)</span></label>
                  <div className="field-with-mic">
                    <textarea
                      placeholder="e.g. 'Write a post arguing that X is underrated' or 'Explain this to a non-technical audience'"
                      value={achieve}
                      onChange={(e) => setAchieve(e.target.value)}
                      rows={2}
                    />
                    <MicButton
                      className="mic-in-field"
                      title="Dictate your goal"
                      onResult={(t) => setAchieve((v) => appendSpoken(v, t))}
                    />
                  </div>
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
                      <li key={i} className="source-card" tabIndex={0}>
                        <span className="source-index">{i + 1}</span>
                        <div className="source-body">
                          <a href={link.url} target="_blank" rel="noopener noreferrer" className="source-title">
                            {link.title || link.url}
                          </a>
                          <span className="source-host">{hostOf(link.url)}</span>
                        </div>
                        <LinkPreview link={link} />
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
                <div className="link-tabs-row">
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
                  <div className="link-tabs-actions">
                    <button onClick={() => goToStep(2)} className="ghost-btn">← Sources</button>
                    <button onClick={() => goToStep(4)}>Review Anchors →</button>
                  </div>
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
                            <div className="chunk" onMouseUp={() => handleChunkMouseUp(key)}>
                              <button
                                type="button"
                                className="chunk-delete"
                                aria-label="Delete chunk"
                                onClick={() => deleteChunk(activeLink, ci)}
                                title="Delete this chunk"
                              >
                                ×
                              </button>
                              <div
                                dangerouslySetInnerHTML={{
                                  __html: hasAnchors && Array.isArray(anchors)
                                    ? parseWithAnchors(injectHighlights(text, anchors))
                                    : marked.parse(text, { renderer: noImgRenderer }),
                                }}
                              />
                            </div>

                            <aside className="chunk-editor">
                              <SpeakButton
                                className="speak-chunk"
                                label="Read chunk"
                                text={stripMarkdown(text)}
                              />
                              <label className="anchor-label">Anchors</label>
                              {!hasAnchors ? (
                                <button className="anchor-btn" onClick={() => createAnchors(activeLink, ci)}>
                                  Create Anchors
                                </button>
                              ) : anchors === null ? (
                                <span className="anchor-label">Extracting anchors…</span>
                              ) : (
                                <div className="anchor-edit-list">
                                  {anchors.map((a, j) => {
                                    const hue = ANCHOR_HUES[j % ANCHOR_HUES.length];
                                    return (
                                      <div key={j} className="anchor-edit-row" data-anchor-idx={j}>
                                        <span className="anchor-color-dot" style={{ '--dot-hue': hue }} />
                                        <input
                                          type="text"
                                          value={a?.phrase ?? a}
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
                                    );
                                  })}
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
              </>
            )}

            {/* ---------- STEP 4: anchor review ---------- */}
            {step === 4 && (
              <>
                {(() => {
                  const byLink = {};
                  Object.entries(anchoredChunks).forEach(([key, anchors]) => {
                    if (!Array.isArray(anchors) || anchors.length === 0) return;
                    const linkIdx = Number(key.split(":")[0]);
                    if (!byLink[linkIdx]) byLink[linkIdx] = [];
                    anchors.forEach((a) => { if (a) byLink[linkIdx].push(a); });
                  });

                  const entries = Object.entries(byLink);
                  if (entries.length === 0) {
                    return <p className="muted">No anchors yet — go back to Step 3 to create some.</p>;
                  }

                  return (
                    <div className="anchor-summary">
                      {entries.map(([linkIdx, anchors]) => {
                        const link = relatedLinks?.[Number(linkIdx)];
                        return (
                          <div key={linkIdx} className="anchor-source-group">
                            <div className="anchor-source-header">
                              <span className="source-index">{Number(linkIdx) + 1}</span>
                              <span className="anchor-source-name">
                                {link?.title || hostOf(link?.url || "")}
                              </span>
                            </div>
                            <div className="anchor-tag-cloud">
                              {anchors.map((a, i) => (
                                <span key={i} className="anchor-tag">{a?.phrase ?? a}</span>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

                <div className="controls">
                  <button onClick={() => goToStep(3)} className="ghost-btn">← Explore</button>
                  <button onClick={() => goToStep(5)}>Reflect →</button>
                </div>
              </>
            )}

            {/* ---------- STEP 5: reflect ---------- */}
            {step === 5 && (
              <>
                <div className="reflect-fields">
                  <div className="reflect-field">
                    <label className="reflect-label">What do you genuinely think about it?</label>
                    <div className="field-with-mic">
                      <textarea
                        placeholder="Share your honest perspective…"
                        value={opinion}
                        onChange={(e) => setOpinion(e.target.value)}
                        rows={4}
                      />
                      <MicButton
                        className="mic-in-field"
                        title="Dictate your answer"
                        onResult={(t) => setOpinion((v) => appendSpoken(v, t))}
                      />
                    </div>
                  </div>
                </div>

                {postError && <p className="error-text">{postError}</p>}

                <div className="controls">
                  <button onClick={() => goToStep(4)} className="ghost-btn">← Anchors</button>
                  <button
                    onClick={() => handleFinalize()}
                    disabled={postLoading || !opinion.trim()}
                  >
                    {postLoading ? "Generating…" : "Finalize"}
                  </button>
                </div>
              </>
            )}

            {/* ---------- STEP 6: generated post ---------- */}
            {step === 6 && (
              <>
                <div className="format-toggle" role="group" aria-label="Output format">
                  <button
                    type="button"
                    className={`format-option${postFormat === "post" ? " active" : ""}`}
                    onClick={() => postFormat !== "post" && handleFinalize("post")}
                    disabled={postLoading}
                  >
                    Short post
                  </button>
                  <button
                    type="button"
                    className={`format-option${postFormat === "article" ? " active" : ""}`}
                    onClick={() => postFormat !== "article" && handleFinalize("article")}
                    disabled={postLoading}
                  >
                    Long article + citations
                  </button>
                </div>

                <div className={`post-card${postFormat === "article" ? " article" : ""}`}>
                  {postLoading ? (
                    <p className="muted">
                      {postFormat === "article" ? "Writing your article…" : "Generating…"}
                    </p>
                  ) : postFormat === "article" ? (
                    <div
                      className="post-article"
                      dangerouslySetInnerHTML={{
                        __html: marked.parse(generatedPost, { renderer: articleRenderer }),
                      }}
                    />
                  ) : (
                    <>
                      <p className="post-text">{generatedPost}</p>
                      {credit && <p className="post-credit">{credit}</p>}
                    </>
                  )}

                  {!postLoading && (
                    <div className="post-footer">
                      <span className="post-wordcount">
                        {generatedPost.trim().split(/\s+/).filter(Boolean).length} words
                      </span>
                      <SpeakButton
                        className="speak-post"
                        label="Read aloud"
                        text={
                          postFormat === "article"
                            ? stripMarkdown(generatedPost)
                            : credit
                              ? `${generatedPost}. ${credit}`
                              : generatedPost
                        }
                      />
                      <button className="copy-btn" onClick={handleCopy}>
                        {copied ? "Copied!" : postFormat === "article" ? "Copy article" : "Copy post"}
                      </button>
                    </div>
                  )}
                </div>

                {postError && <p className="error-text">{postError}</p>}

                <div className="controls">
                  <button onClick={() => goToStep(5)} className="ghost-btn">← Reflect</button>
                  <button
                    className="ghost-btn"
                    onClick={() => handleFinalize()}
                    disabled={postLoading}
                  >
                    {postLoading ? "Regenerating…" : "Regenerate"}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      </main>

      <footer className="site-footer">
        Powered by Browserbase APIs · Browserbase CLI · Claude Code · Claude API
      </footer>

      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" aria-label="Close" onClick={() => setModal(null)}>×</button>

            {modal === "how" && (
              <>
                <p className="eyebrow">How it works</p>
                <h2 className="modal-title">From a question to a credited post.</h2>
                <ol className="modal-steps">
                  <li><strong>Anchor</strong> — Describe what you're researching. AnchorPoint searches the web and brings back the sources worth following.</li>
                  <li><strong>Sources</strong> — Review the links we found, it is limited to 4 right now (no less than 4 for strong sources).</li>
                  <li><strong>Explore</strong> — Each source is converted to clean Markdown and split into chunks. Drop <em>anchors</em> on the load-bearing ideas, and edit them inline.</li>
                  <li><strong>Review</strong> — See every anchor you marked across all sources, grouped by source.</li>
                  <li><strong>Reflect</strong> — Answer two honest questions: what you want to achieve, and what you genuinely think.</li>
                  <li><strong>Post</strong> — Your research, anchors, and take are distilled into one shareable post — with credit to the sources.</li>
                </ol>
              </>
            )}

            {modal === "about" && (
              <>
                <p className="eyebrow">About</p>
                <h2 className="modal-title">Read deeper. Explore further.</h2>
                <p className="modal-body">
                  AnchorPoint turns scattered reading into an original, credited point of view. Instead of
                  skimming, you pinpoint the <em>anchors</em> — the structural ideas a text is actually built
                  around — and turn them into a post that's grounded in real sources, not hallucinated.
                </p>
                <p className="modal-body">
                  Built with <strong>Browserbase</strong> (web search &amp; page-to-Markdown fetch) and
                  <strong> Claude</strong> (anchor extraction &amp; writing).
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {selectionPopover && (
        <>
          <div className="selection-backdrop" onClick={() => setSelectionPopover(null)} />
          <div
            className="selection-popover"
            style={{ top: selectionPopover.top, left: selectionPopover.left }}
          >
            <button onClick={addSelectionAsAnchor}>+ Add as anchor</button>
          </div>
        </>
      )}
    </>
  );
}
