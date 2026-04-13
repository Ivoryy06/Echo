// Echo — reflective journaling app
// Dual mode: local (Flask + SQLite) or web (Gemini direct + localStorage/IndexedDB)
// Offline-first: caches entries locally, syncs to backend when reachable

import { useState, useEffect, useCallback, useRef } from "react";

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE     = import.meta.env.VITE_API_BASE ?? "";
const IS_WEB_MODE  = !API_BASE || import.meta.env.VITE_WEB_MODE === "true";
const GEMINI_MODEL = "gemini-1.5-flash";
const SUMMARY_EVERY = 5;

const EMOTIONS = ["joy","sadness","anger","fear","disgust","surprise","anxiety","love","grief","hope","shame","pride","neutral"];

const EMOTION_COLOR = {
  joy:"#f6c90e", sadness:"#5b8dee", anger:"#e05c5c", fear:"#9b59b6",
  disgust:"#27ae60", surprise:"#e67e22", anxiety:"#e74c3c", love:"#e91e8c",
  grief:"#607d8b", hope:"#00bcd4", shame:"#795548", pride:"#ff9800", neutral:"#9e9e9e",
};

const MIRROR_MODES = [
  { key:"rewrite",      label:"Reflect",     desc:"Mirrors your entry back with compassion" },
  { key:"question",     label:"Question",    desc:"Asks gentle questions to go deeper" },
  { key:"continuation", label:"Continue",    desc:"Continues your entry in your voice" },
];

// ── IndexedDB (offline cache) ─────────────────────────────────────────────────

const DB_NAME = "echo_offline";
const STORE   = "pending_entries";

function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: "local_id", autoIncrement: true });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e);
  });
}

async function idbAdd(entry) {
  const db  = await openIDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add(entry);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function idbGetAll() {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function idbClear() {
  const db = await openIDB();
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, "readwrite").objectStore(STORE).clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

// ── Gemini (web mode) ─────────────────────────────────────────────────────────

async function callGemini(apiKey, prompt) {
  const url  = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}`);
  const data = await resp.json();
  return data.candidates[0].content.parts[0].text.trim();
}

function tagPrompt(body) {
  return `Identify the single dominant emotion in this journal entry. Choose exactly one from: ${EMOTIONS.join(", ")}. Reply with only the emotion word.\n\n${body}`;
}

function mirrorPrompt(body, mode) {
  const p = {
    rewrite:      `Gently rewrite this journal entry in second person, as if a compassionate friend is reflecting it back. Keep the emotional truth but soften harsh self-judgment.\n\n${body}`,
    question:     `Read this journal entry and respond with 2–3 gentle open-ended questions that invite deeper reflection. Don't interpret or advise — only ask.\n\n${body}`,
    continuation: `Continue this journal entry in the same voice and emotional register, as if the writer kept going. Write 2–4 sentences.\n\n${body}`,
  };
  return p[mode] ?? p.rewrite;
}

function summaryPrompt(entries) {
  const block = entries.map((e, i) => `[${i+1}] ${e.body}`).join("\n\n---\n\n");
  return `You are a thoughtful journaling companion. Read these journal entries and write a warm 2–3 paragraph summary identifying recurring themes, emotional patterns, and shifts in perspective. Speak directly to the writer in second person. Be gentle, not clinical.\n\n${block}`;
}

// ── localStorage helpers ──────────────────────────────────────────────────────

function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// ── Tiny UI components ────────────────────────────────────────────────────────

const Spinner = () => (
  <span style={{ display:"inline-block", width:16, height:16, border:"2px solid var(--accent)", borderTopColor:"transparent", borderRadius:"50%", animation:"spin 0.7s linear infinite", verticalAlign:"middle" }}/>
);

const EmotionDot = ({ emotion, size=10 }) => (
  <span style={{ display:"inline-block", width:size, height:size, borderRadius:"50%", background: EMOTION_COLOR[emotion] ?? "#9e9e9e", flexShrink:0 }} title={emotion}/>
);

const Toast = ({ msg, onDone }) => {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return (
    <div style={{ position:"fixed", bottom:24, left:"50%", transform:"translateX(-50%)", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:8, padding:"10px 20px", fontSize:13, color:"var(--text)", boxShadow:"0 4px 20px rgba(0,0,0,0.15)", zIndex:999 }}>
      {msg}
    </div>
  );
};

// ── Mood Timeline ─────────────────────────────────────────────────────────────

function MoodTimeline({ entries }) {
  if (!entries.length) return null;
  const sorted = [...entries].sort((a,b) => a.created_at - b.created_at);
  return (
    <div style={{ marginTop:"1.5rem" }}>
      <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--muted)", marginBottom:8 }}>Mood Timeline</div>
      <div style={{ display:"flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
        {sorted.map((e, i) => (
          <div key={i} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:3 }}>
            <EmotionDot emotion={e.emotion} size={12}/>
            <span style={{ fontSize:9, color:"var(--muted)", writingMode:"vertical-rl", transform:"rotate(180deg)", maxHeight:40, overflow:"hidden" }}>
              {new Date(e.created_at * 1000).toLocaleDateString(undefined, { month:"short", day:"numeric" })}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:"6px 12px", marginTop:10 }}>
        {EMOTIONS.filter(em => entries.some(e => e.emotion === em)).map(em => (
          <span key={em} style={{ display:"flex", alignItems:"center", gap:4, fontSize:11, color:"var(--muted)" }}>
            <EmotionDot emotion={em} size={8}/>{em}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Entry Card ────────────────────────────────────────────────────────────────

function EntryCard({ entry, onDelete }) {
  const [open, setOpen] = useState(false);
  const date = new Date(entry.created_at * 1000).toLocaleString(undefined, {
    month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"
  });
  const modeLabel = MIRROR_MODES.find(m => m.key === entry.mirror_mode)?.label ?? "Reflect";

  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10, padding:"14px 16px", marginBottom:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
        <EmotionDot emotion={entry.emotion}/>
        <span style={{ fontSize:12, color:"var(--muted)", flex:1 }}>{date}</span>
        <span style={{ fontSize:11, padding:"2px 8px", borderRadius:20, background:"var(--accent-light)", color:"var(--accent)" }}>{modeLabel}</span>
        <button onClick={() => onDelete(entry.id)} style={{ background:"none", border:"none", cursor:"pointer", color:"var(--muted)", fontSize:14, padding:2 }}>✕</button>
      </div>
      <p style={{ fontSize:14, lineHeight:1.7, color:"var(--text)", margin:0, whiteSpace:"pre-wrap" }}>{entry.body}</p>
      {entry.mirror && (
        <>
          <button onClick={() => setOpen(v => !v)} style={{ marginTop:10, background:"none", border:"none", cursor:"pointer", fontSize:12, color:"var(--accent)", padding:0 }}>
            {open ? "▲ Hide reflection" : "▼ Show reflection"}
          </button>
          {open && (
            <div style={{ marginTop:8, padding:"10px 14px", background:"var(--accent-light)", borderRadius:8, fontSize:13, lineHeight:1.8, color:"var(--text)", fontStyle:"italic", whiteSpace:"pre-wrap" }}>
              {entry.mirror}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({ summary }) {
  return (
    <div style={{ background:"var(--surface)", border:"1px solid var(--accent-mid)", borderRadius:10, padding:"14px 16px", marginBottom:10 }}>
      <div style={{ fontSize:11, textTransform:"uppercase", letterSpacing:"0.08em", color:"var(--accent)", marginBottom:6 }}>
        Theme Summary · Entries {summary.range ?? summary.entry_range}
      </div>
      <p style={{ fontSize:13, lineHeight:1.8, color:"var(--text)", margin:0, whiteSpace:"pre-wrap" }}>{summary.content}</p>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [tab,        setTab]        = useState("write");
  const [body,       setBody]       = useState("");
  const [mode,       setMode]       = useState("rewrite");
  const [entries,    setEntries]    = useState(() => lsGet("echo_entries", []));
  const [summaries,  setSummaries]  = useState(() => lsGet("echo_summaries", []));
  const [loading,    setLoading]    = useState(false);
  const [toast,      setToast]      = useState(null);
  const [apiKey,     setApiKey]     = useState(() => localStorage.getItem("echo_gemini_key") || "");
  const [showKey,    setShowKey]    = useState(false);
  const [isOnline,   setIsOnline]   = useState(navigator.onLine);
  const [backendOk,  setBackendOk]  = useState(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastResult, setLastResult] = useState(null); // { mirror, emotion, summary }

  // ── online/offline ──
  useEffect(() => {
    const on  = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online",  on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // ── backend health check ──
  useEffect(() => {
    if (IS_WEB_MODE) { setBackendOk(false); return; }
    fetch(`${API_BASE}/api/health`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setBackendOk(!!d))
      .catch(() => setBackendOk(false));
  }, []);

  // ── load entries from backend ──
  useEffect(() => {
    if (!backendOk) return;
    fetch(`${API_BASE}/api/entries`).then(r => r.json()).then(data => {
      setEntries(data);
      lsSet("echo_entries", data);
    }).catch(() => {});
    fetch(`${API_BASE}/api/summaries`).then(r => r.json()).then(data => {
      setSummaries(data);
      lsSet("echo_summaries", data);
    }).catch(() => {});
  }, [backendOk]);

  // ── pending offline count ──
  useEffect(() => {
    idbGetAll().then(items => setPendingCount(items.length)).catch(() => {});
  }, []);

  // ── sync offline cache when back online ──
  useEffect(() => {
    if (!isOnline || !backendOk) return;
    idbGetAll().then(async items => {
      if (!items.length) return;
      const resp = await fetch(`${API_BASE}/api/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: items }),
      });
      if (resp.ok) {
        await idbClear();
        setPendingCount(0);
        setToast(`Synced ${items.length} offline ${items.length === 1 ? "entry" : "entries"}`);
        // reload
        fetch(`${API_BASE}/api/entries`).then(r => r.json()).then(data => { setEntries(data); lsSet("echo_entries", data); });
      }
    }).catch(() => {});
  }, [isOnline, backendOk]);

  // ── submit entry ──
  const submit = useCallback(async () => {
    if (!body.trim()) return;
    setLoading(true);
    setLastResult(null);

    try {
      if (backendOk) {
        // ── local mode: Flask handles everything ──
        const resp = await fetch(`${API_BASE}/api/entries`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: body.trim(), mirror_mode: mode }),
        });
        const data = await resp.json();
        const updated = [data, ...entries];
        setEntries(updated);
        lsSet("echo_entries", updated);
        setLastResult({ mirror: data.mirror, emotion: data.emotion, summary: data.summary });
        if (data.summary) {
          const updatedS = [data.summary, ...summaries];
          setSummaries(updatedS);
          lsSet("echo_summaries", updatedS);
        }
      } else if (isOnline && apiKey) {
        // ── web mode: call Gemini directly ──
        const [emotion, mirror] = await Promise.all([
          callGemini(apiKey, tagPrompt(body.trim())).then(r => {
            const e = r.toLowerCase().trim();
            return EMOTIONS.includes(e) ? e : "neutral";
          }),
          callGemini(apiKey, mirrorPrompt(body.trim(), mode)),
        ]);
        const entry = { id: Date.now(), created_at: Date.now() / 1000, body: body.trim(), emotion, mirror_mode: mode, mirror, tags: "[]" };
        const updated = [entry, ...entries];
        setEntries(updated);
        lsSet("echo_entries", updated);
        setLastResult({ mirror, emotion, summary: null });

        // periodic summary in web mode
        if (updated.length % SUMMARY_EVERY === 0) {
          const slice = updated.slice(0, SUMMARY_EVERY);
          const text  = await callGemini(apiKey, summaryPrompt(slice));
          const s     = { id: Date.now(), created_at: Date.now() / 1000, entry_range: `${updated.length - SUMMARY_EVERY + 1}–${updated.length}`, content: text };
          const updatedS = [s, ...summaries];
          setSummaries(updatedS);
          lsSet("echo_summaries", updatedS);
          setLastResult(r => ({ ...r, summary: s }));
        }
      } else {
        // ── offline: cache to IndexedDB ──
        const entry = { created_at: Date.now() / 1000, body: body.trim(), mirror_mode: mode, tags: [] };
        await idbAdd(entry);
        const localEntry = { ...entry, id: Date.now(), emotion: "neutral", mirror: null };
        const updated = [localEntry, ...entries];
        setEntries(updated);
        lsSet("echo_entries", updated);
        setPendingCount(c => c + 1);
        setToast("Saved offline — will sync when connected");
      }
      setBody("");
      setTab("entries");
    } catch (e) {
      setToast("Something went wrong: " + e.message);
    } finally {
      setLoading(false);
    }
  }, [body, mode, entries, summaries, backendOk, isOnline, apiKey]);

  const deleteEntry = useCallback(async (id) => {
    if (backendOk) {
      await fetch(`${API_BASE}/api/entries/${id}`, { method: "DELETE" }).catch(() => {});
    }
    const updated = entries.filter(e => e.id !== id);
    setEntries(updated);
    lsSet("echo_entries", updated);
  }, [entries, backendOk]);

  const webMode = !backendOk;
  const canSubmit = body.trim().length >= 10 && !loading && (backendOk || (isOnline && apiKey) || !isOnline);

  return (
    <div style={{ fontFamily:"system-ui, -apple-system, sans-serif", maxWidth:680, margin:"0 auto", padding:"2rem 1.25rem", minHeight:"100vh" }}>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"2rem" }}>
        <div>
          <h1 style={{ fontSize:26, fontWeight:700, margin:0, color:"var(--text)", letterSpacing:"-0.3px" }}>🪞 Echo</h1>
          <p style={{ fontSize:12, color:"var(--muted)", margin:"2px 0 0", fontStyle:"italic" }}>your voice, reflected</p>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {pendingCount > 0 && (
            <span style={{ fontSize:11, padding:"3px 8px", borderRadius:20, background:"#fff3cd", color:"#856404", border:"1px solid #ffc107" }}>
              {pendingCount} pending
            </span>
          )}
          <span style={{ fontSize:11, padding:"3px 10px", borderRadius:20, border:"1px solid",
            background: isOnline ? "var(--green-bg)" : "var(--red-bg)",
            color:      isOnline ? "var(--green)"    : "var(--red)",
            borderColor:isOnline ? "#a8d8b8"         : "#e8b0a0",
          }}>
            {isOnline ? (backendOk ? "● local" : "● web") : "● offline"}
          </span>
          {webMode && (
            <button onClick={() => setShowKey(v => !v)} style={{ fontSize:12, padding:"4px 10px", borderRadius:6, border:"1px solid var(--border)", background:"var(--surface)", cursor:"pointer", color:"var(--text)" }}>
              {apiKey ? "🔑 key set" : "🔑 API key"}
            </button>
          )}
        </div>
      </div>

      {/* API key input (web mode) */}
      {webMode && showKey && (
        <div style={{ marginBottom:"1.5rem", padding:"12px 16px", background:"var(--surface)", border:"1px solid var(--border)", borderRadius:10 }}>
          <label style={{ fontSize:12, color:"var(--muted)", display:"block", marginBottom:6 }}>Gemini API Key (stored in browser only)</label>
          <input type="password" value={apiKey}
            onChange={e => { setApiKey(e.target.value); localStorage.setItem("echo_gemini_key", e.target.value); }}
            placeholder="AIza..."
            style={{ width:"100%", padding:"8px 10px", fontSize:13, border:"1px solid var(--border)", borderRadius:6, fontFamily:"monospace", background:"var(--bg)", color:"var(--text)", boxSizing:"border-box" }}
          />
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:"flex", borderBottom:"1px solid var(--border)", marginBottom:"1.5rem", gap:2 }}>
        {[["write","Write"],["entries","Entries"],["timeline","Timeline"],["summaries","Summaries"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={{
            padding:"8px 16px", fontSize:13, border:"none", cursor:"pointer", borderBottom:"2px solid",
            background:"none", fontFamily:"inherit",
            color:       tab===id ? "var(--accent)"  : "var(--muted)",
            borderColor: tab===id ? "var(--accent)"  : "transparent",
            fontWeight:  tab===id ? 600 : 400,
          }}>{label}</button>
        ))}
      </div>

      {/* ── WRITE ── */}
      {tab === "write" && (
        <div>
          {/* Mirror mode picker */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:8, marginBottom:"1.25rem" }}>
            {MIRROR_MODES.map(m => (
              <button key={m.key} onClick={() => setMode(m.key)} style={{
                padding:"10px 12px", textAlign:"left", cursor:"pointer", border:"1px solid",
                borderRadius:8, background: mode===m.key ? "var(--accent-light)" : "var(--surface)",
                borderColor: mode===m.key ? "var(--accent-mid)" : "var(--border)",
              }}>
                <div style={{ fontSize:13, fontWeight:500, color: mode===m.key ? "var(--accent)" : "var(--text)" }}>{m.label}</div>
                <div style={{ fontSize:11, color:"var(--muted)", marginTop:2 }}>{m.desc}</div>
              </button>
            ))}
          </div>

          <textarea value={body} onChange={e => setBody(e.target.value)}
            placeholder="What's on your mind today…"
            rows={8}
            style={{ width:"100%", padding:"14px 16px", fontSize:15, lineHeight:1.9, border:"1px solid var(--border)", borderRadius:10, fontFamily:"Georgia, serif", color:"var(--text)", background:"var(--bg)", resize:"vertical", boxSizing:"border-box" }}
          />
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8 }}>
            <span style={{ fontSize:12, color:"var(--muted)" }}>{body.trim().split(/\s+/).filter(Boolean).length} words</span>
            <button onClick={submit} disabled={!canSubmit} style={{
              padding:"10px 24px", fontSize:14, fontWeight:600, borderRadius:8, border:"none", cursor: canSubmit ? "pointer" : "not-allowed",
              background: canSubmit ? "var(--accent)" : "var(--border)", color: canSubmit ? "#fff" : "var(--muted)",
              display:"flex", alignItems:"center", gap:8,
            }}>
              {loading ? <><Spinner/> Reflecting…</> : "Reflect →"}
            </button>
          </div>

          {/* Last result */}
          {lastResult && (
            <div style={{ marginTop:"1.5rem" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
                <EmotionDot emotion={lastResult.emotion} size={12}/>
                <span style={{ fontSize:12, color:"var(--muted)" }}>Detected: <strong>{lastResult.emotion}</strong></span>
              </div>
              {lastResult.mirror && (
                <div style={{ padding:"14px 18px", background:"var(--accent-light)", border:"1px solid var(--accent-mid)", borderRadius:10, fontSize:14, lineHeight:1.9, color:"var(--text)", fontStyle:"italic", whiteSpace:"pre-wrap" }}>
                  {lastResult.mirror}
                </div>
              )}
              {lastResult.summary && (
                <div style={{ marginTop:12 }}>
                  <SummaryCard summary={lastResult.summary}/>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── ENTRIES ── */}
      {tab === "entries" && (
        <div>
          {entries.length === 0
            ? <p style={{ color:"var(--muted)", fontSize:14 }}>No entries yet. Write your first one.</p>
            : entries.map(e => <EntryCard key={e.id} entry={e} onDelete={deleteEntry}/>)
          }
        </div>
      )}

      {/* ── TIMELINE ── */}
      {tab === "timeline" && (
        <div>
          <MoodTimeline entries={entries}/>
          {entries.length === 0 && <p style={{ color:"var(--muted)", fontSize:14 }}>No entries yet.</p>}
        </div>
      )}

      {/* ── SUMMARIES ── */}
      {tab === "summaries" && (
        <div>
          {summaries.length === 0
            ? <p style={{ color:"var(--muted)", fontSize:14 }}>Summaries appear every {SUMMARY_EVERY} entries.</p>
            : summaries.map((s, i) => <SummaryCard key={i} summary={s}/>)
          }
        </div>
      )}

      {toast && <Toast msg={toast} onDone={() => setToast(null)}/>}
    </div>
  );
}
