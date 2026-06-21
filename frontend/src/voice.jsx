// Browser-native voice helpers (no backend, no API keys).
//   - MicButton: dictation via the Web Speech API's SpeechRecognition.
//   - SpeakButton: read-aloud via SpeechSynthesis.
// Both render nothing when the browser lacks support, so callers can drop them
// in unconditionally.
import { useEffect, useRef, useState } from "react";

const SpeechRecognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

const synth = typeof window !== "undefined" ? window.speechSynthesis : null;

// Append freshly dictated text to whatever is already in a field, keeping a
// single space between phrases and capitalising the very first character.
export function appendSpoken(prev, text) {
  const clean = (text || "").trim();
  if (!clean) return prev;
  if (!prev) return clean.charAt(0).toUpperCase() + clean.slice(1);
  return prev.replace(/\s+$/, "") + " " + clean;
}

// Rough markdown -> speakable plain text so read-aloud doesn't pronounce
// "#", "*", link syntax, etc.
export function stripMarkdown(md) {
  return (md || "")
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> text
    .replace(/^[#>\s-]+/gm, "") // heading/quote/list markers
    .replace(/[*_~]/g, "") // emphasis
    .replace(/\|/g, " ") // table pipes
    .replace(/\s+\n/g, "\n")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

const MicIcon = ({ listening }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
    {listening ? (
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    ) : (
      <>
        <rect x="9" y="2" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <line x1="12" y1="18" x2="12" y2="22" />
      </>
    )}
  </svg>
);

const SpeakIcon = ({ speaking }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
    {speaking ? (
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    ) : (
      <>
        <polygon points="4 9 8 9 13 5 13 19 8 15 4 15" fill="currentColor" stroke="none" />
        <path d="M16 8a4 4 0 0 1 0 8" />
        <path d="M18.5 5.5a8 8 0 0 1 0 13" />
      </>
    )}
  </svg>
);

// Mic button: click to dictate one phrase into a field. `onResult` receives the
// recognised text; the caller decides how to merge it (see appendSpoken).
export function MicButton({ onResult, title = "Dictate", className = "" }) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);

  useEffect(
    () => () => {
      try {
        recRef.current?.abort();
      } catch {
        /* ignore */
      }
    },
    [],
  );

  if (!SpeechRecognition) return null;

  function toggle() {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join(" ");
      if (text) onResult(text);
    };
    rec.onerror = () => setListening(false);
    rec.onend = () => setListening(false);
    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  }

  return (
    <button
      type="button"
      className={`mic-btn${listening ? " listening" : ""} ${className}`.trim()}
      onClick={toggle}
      aria-pressed={listening}
      title={listening ? "Stop listening" : title}
      aria-label={listening ? "Stop dictation" : title}
    >
      <MicIcon listening={listening} />
    </button>
  );
}

// Read-aloud button. Speaks `text`; clicking again (or starting another button)
// stops it. Starting one cancels any other in-progress speech.
export function SpeakButton({ text, label = "Read aloud", className = "" }) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(
    () => () => {
      try {
        synth?.cancel();
      } catch {
        /* ignore */
      }
    },
    [],
  );

  if (!synth) return null;

  function toggle() {
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const clean = (text || "").trim();
    if (!clean) return;
    synth.cancel(); // stop anything else currently speaking
    const utt = new SpeechSynthesisUtterance(clean);
    utt.rate = 1;
    utt.onend = () => setSpeaking(false);
    utt.onerror = () => setSpeaking(false);
    setSpeaking(true);
    synth.speak(utt);
  }

  return (
    <button
      type="button"
      className={`speak-btn${speaking ? " speaking" : ""} ${className}`.trim()}
      onClick={toggle}
      aria-pressed={speaking}
      title={speaking ? "Stop reading" : label}
    >
      <SpeakIcon speaking={speaking} />
      <span>{speaking ? "Stop" : label}</span>
    </button>
  );
}
