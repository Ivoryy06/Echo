// Echo — reflective journaling app
// Dual mode: local (Flask + SQLite) or web (Groq direct + localStorage/IndexedDB)
// Offline-first: caches entries locally, syncs to backend when reachable

import { useState, useEffect, useCallback, useRef } from "react";

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE     = import.meta.env.VITE_API_BASE ?? "";
const IS_WEB_MODE  = !API_BASE || import.meta.env.VITE_WEB_MODE === "true";
const GROQ_MODEL  = "llama3-8b-8192";
const GROQ_BASE   = "https://api.groq.com/openai/v1";
const SUMMARY_EVERY = 15;

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

// ── Groq (web mode) ───────────────────────────────────────────────────────────

async function callGroq(apiKey, prompt) {
  const resp = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 1024 }),
  });
  if (!resp.ok) throw new Error(`Groq ${resp.status}`);
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

const CRISIS_SIGNALS = [
  "don't want to be here","don't want to exist","want to disappear","want to die",
  "end it","end my life","kill myself","killing myself","no reason to live",
  "can't go on","nobody would miss me","better off without me",
];

const HEAVY_SIGNALS = [
  "can't do this anymore","worthless","hopeless","nothing matters","give up on everything",
  "can't feel anything","numb to everything","completely empty","falling apart","breaking down",
  "hate myself","i'm a failure","i'm pathetic","i'm useless","i'm broken",
  "so angry","so much anger","i'm furious","i'm so angry",
  "grief","grieving","i'm grieving","lost everything",
];

function entryWeight(body) {
  const b = body.toLowerCase();
  if (CRISIS_SIGNALS.some(s => b.includes(s))) return "crisis";
  if (HEAVY_SIGNALS.some(s => b.includes(s)))  return "heavy";
  return null;
}

function isDark(body) { return entryWeight(body) !== null; }

const CRISIS_PREAMBLE = `IMPORTANT CONTEXT: This entry contains language that suggests the writer may be in significant emotional pain or distress.

Your response must:
- Be quieter and slower than usual — no warmth that feels performative
- Acknowledge the weight of what they wrote without minimising or rushing past it
- Not offer solutions, reframes, or silver linings of any kind
- Not use words like "journey", "growth", "strength", or "healing"
- End your response with this exact line on its own paragraph:
  "If you're in crisis, you don't have to carry this alone. You can reach the 988 Suicide & Crisis Lifeline by calling or texting 988."

`;

const HEAVY_PREAMBLE = `IMPORTANT CONTEXT: This entry carries real emotional weight — grief, self-criticism, or anger.

Your response must:
- Move slowly. Don't rush to comfort or resolve.
- Sit with the feeling before anything else — name it plainly, without softening it into something easier.
- Soften harsh self-criticism gently: don't erase it, but don't echo it back unchanged either.
- For anger: acknowledge it as valid before anything else. Don't redirect or explain it away.
- For grief: don't reach for meaning. Just be present with the loss.
- No silver linings, no reframes, no words like "journey", "growth", "strength", or "healing".
- End quietly — not with hope or resolution, just with the sense that you were truly here.

`;

function getPreamble(body) {
  const w = entryWeight(body);
  if (w === "crisis") return CRISIS_PREAMBLE;
  if (w === "heavy")  return HEAVY_PREAMBLE;
  return "";
}

function toneNote(body) {
  const words    = body.split(/\s+/);
  const avgLen   = words.reduce((s, w) => s + w.length, 0) / Math.max(words.length, 1);
  const sents    = body.split(/[.!?]+/).filter(s => s.trim());
  const avgSent  = words.length / Math.max(sents.length, 1);
  const informal = /\bi'm\b|\bi've\b|\bcan't\b|\bdon't\b|\bgonna\b|\bkinda\b/i.test(body);
  const hasQ     = body.includes("?");
  if (avgSent < 8 && informal)
    return "The writer uses short, casual sentences. Match that rhythm — keep your response brief and conversational, not formal.";
  if (avgLen > 6 && avgSent > 20)
    return "The writer uses long, considered sentences with rich vocabulary. Match that register — write with care and some complexity.";
  if (hasQ)
    return "The writer is already questioning themselves. Honour that uncertainty — don't resolve it, sit with it.";
  return "Match the writer's natural voice — don't be more formal or more casual than they are.";
}

function mirrorPrompt(body, mode) {
  const tone = toneNote(body);
  const dark = isDark(body);
  const preamble = getPreamble(body);

  if (mode === "rewrite") return `${preamble}You are a compassionate journaling companion. Your task is to gently reflect this journal entry back to the writer in second person — as if a trusted friend who truly listened is now speaking.

Tone guidance: ${tone}

Rules:
- Preserve every emotional truth, even the painful ones. Do not minimise or fix.
- Soften harsh self-criticism without erasing it — transform "I'm a failure" into "you've been carrying a heavy sense of not being enough."
- Do not add advice, silver linings, or conclusions the writer didn't reach themselves.
- Write in flowing prose, same approximate length as the original.
- Begin mid-thought, not with "You wrote…" or "It sounds like…"

Journal entry:
${body}`;

  if (mode === "question") return `${preamble}You are a gentle journaling companion. Read this entry carefully, then offer 2–3 open questions that invite the writer to go one layer deeper.

Tone guidance: ${tone}

Rules:
- Ask only — never interpret, advise, or summarise.
- Each question should open a door, not close one. Avoid yes/no questions.
- Questions should feel like they come from someone who read every word, not a generic prompt.
- Space them on separate lines. No preamble, no closing remark.
- If the entry is already asking questions, ask questions about those questions.

Journal entry:
${body}`;

  if (mode === "continuation") {
    if (dark) return mirrorPrompt(body, "rewrite"); // don't continue dark entries
    return `You are a ghostwriter who has just read this journal entry. Continue it in the writer's exact voice — same sentence rhythm, same vocabulary register, same emotional temperature.

Tone guidance: ${tone}

Rules:
- Write 3–5 sentences. No more.
- Do not resolve anything the writer left unresolved. Do not introduce new topics.
- Do not begin with "And" or repeat the last sentence.
- The continuation should feel like the writer kept going, not like someone else took over.
- If the entry ends mid-thought, continue that thought.

Journal entry:
${body}`;
  }

  return mirrorPrompt(body, "rewrite");
}

function tagPrompt(body) {
  return `Identify the single dominant emotion in this journal entry. Choose exactly one from: ${EMOTIONS.join(", ")}. Reply with only the emotion word.\n\n${body}`;
}

function summaryPrompt(entries) {
  const block = entries.map((e, i) => `[${i+1}] ${e.body}`).join("\n\n---\n\n");
  return `You are a thoughtful journaling companion who has been reading someone's private journal over time.

Read these ${entries.length} entries and write a warm, personal summary (2–3 paragraphs) that:
- Names the recurring themes you noticed, without labelling them clinically
- Reflects any emotional shifts or patterns across the entries
- Notices what the writer keeps returning to, even indirectly
- Speaks directly to the writer in second person, as a trusted witness — not a therapist

Do not list bullet points. Do not give advice. Do not be cheerful if the entries aren't.
Write as if you genuinely know this person.

Entries:
${block}`;
}

// ── localStorage helpers ──────────────────────────────────────────────────────

function lsGet(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// ── Tiny UI components ────────────────────────────────────────────────────────

const Spinner = () => (
  <span style={{ display:"inline-block", width:14, height:14, border:"2px solid rgba(13,13,15,0.3)", borderTopColor:"#0d0d0f", borderRadius:"50%", animation:"spin 0.7s linear infinite", verticalAlign:"middle" }}/>
);

const EmotionDot = ({ emotion, size=10 }) => (
  <span style={{ display:"inline-block", width:size, height:size, borderRadius:"50%", background: EMOTION_COLOR[emotion] ?? "#4a4a5a", flexShrink:0 }} title={emotion}/>
);

const Toast = ({ msg, onDone }) => {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return <div className="toast">{msg}</div>;
};

// ── Mood Timeline ─────────────────────────────────────────────────────────────

function MoodTimeline({ entries }) {
  if (!entries.length) return <p className="empty-state">No entries yet.</p>;

  const sorted = [...entries].sort((a, b) => a.created_at - b.created_at);

  function weekKey(ts) {
    const d = new Date(ts * 1000);
    const day = d.getDay() || 7;
    const mon = new Date(d); mon.setDate(d.getDate() - day + 1);
    return mon.toISOString().slice(0, 10);
  }

  const weeks = {};
  for (const e of sorted) {
    const wk = weekKey(e.created_at);
    if (!weeks[wk]) weeks[wk] = {};
    weeks[wk][e.emotion] = (weeks[wk][e.emotion] || 0) + 1;
  }

  const weekKeys = Object.keys(weeks).sort();
  const totals = {};
  for (const e of sorted) totals[e.emotion] = (totals[e.emotion] || 0) + 1;
  const topEmotions = Object.entries(totals).sort((a,b) => b[1]-a[1]).map(([em]) => em);

  return (
    <div className="timeline-wrap">
      <p className="timeline-stat">{sorted.length} {sorted.length === 1 ? "entry" : "entries"} · weekly mood</p>

      <div style={{ overflowX:"auto" }}>
        <div style={{ display:"flex", alignItems:"flex-end", gap:6, minWidth: weekKeys.length * 44, paddingBottom:4 }}>
          {weekKeys.map(wk => {
            const week = weeks[wk];
            const total = Object.values(week).reduce((s,n) => s+n, 0);
            return (
              <div key={wk} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:4, flex:"0 0 38px" }}>
                <div style={{ width:28, height:80, display:"flex", flexDirection:"column-reverse", borderRadius:5, overflow:"hidden", background:"var(--surface-2)" }}>
                  {Object.entries(week).map(([em, count]) => (
                    <div key={em} title={`${em}: ${count}`}
                      style={{ width:"100%", height:`${(count/total)*100}%`, background: EMOTION_COLOR[em] ?? "#4a4a5a" }}
                    />
                  ))}
                </div>
                <span style={{ fontSize:9, color:"var(--muted)", textAlign:"center" }}>
                  {new Date(wk).toLocaleDateString(undefined, { month:"short", day:"numeric" })}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display:"flex", flexWrap:"wrap", gap:"6px 14px", marginTop:18 }}>
        {topEmotions.map(em => (
          <span key={em} style={{ display:"flex", alignItems:"center", gap:5, fontSize:11.5, color:"var(--text-dim)" }}>
            <span style={{ width:9, height:9, borderRadius:2, background: EMOTION_COLOR[em], display:"inline-block" }}/>
            {em} <span style={{ color:"var(--text)", fontWeight:500 }}>×{totals[em]}</span>
          </span>
        ))}
      </div>

      <div style={{ display:"flex", gap:4, flexWrap:"wrap", marginTop:20 }}>
        {sorted.slice(-20).map((e, i) => (
          <span key={i} title={`${e.emotion} · ${new Date(e.created_at*1000).toLocaleDateString()}`}
            style={{ width:10, height:10, borderRadius:"50%", background: EMOTION_COLOR[e.emotion] ?? "#4a4a5a", display:"inline-block" }}
          />
        ))}
        {sorted.length > 20 && <span style={{ fontSize:10, color:"var(--muted)", alignSelf:"center" }}>+{sorted.length-20}</span>}
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
    <div className="entry-card">
      <div className="entry-meta">
        <EmotionDot emotion={entry.emotion}/>
        <span className="entry-date">{date}</span>
        <span className="entry-mode-tag">{modeLabel}</span>
        <button className="delete-btn" onClick={() => onDelete(entry.id)}>✕</button>
      </div>
      <p className="entry-body">{entry.body}</p>
      {entry.mirror && (
        <>
          <button className="toggle-mirror-btn" onClick={() => setOpen(v => !v)}>
            {open ? "▲ hide reflection" : "▼ show reflection"}
          </button>
          {open && <div className="mirror-collapsed">{entry.mirror}</div>}
        </>
      )}
    </div>
  );
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({ summary }) {
  return (
    <div className="summary-card">
      <div className="summary-label">Theme Summary · Entries {summary.range ?? summary.entry_range}</div>
      <p className="summary-text">{summary.content}</p>
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
  const [apiKey,     setApiKey]     = useState(() => localStorage.getItem("echo_groq_key") || "");
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
          callGroq(apiKey, tagPrompt(body.trim())).then(r => {
            const e = r.toLowerCase().trim();
            return EMOTIONS.includes(e) ? e : "neutral";
          }),
          callGroq(apiKey, mirrorPrompt(body.trim(), mode)),
        ]);
        const entry = { id: Date.now(), created_at: Date.now() / 1000, body: body.trim(), emotion, mirror_mode: mode, mirror, tags: "[]" };
        const updated = [entry, ...entries];
        setEntries(updated);
        lsSet("echo_entries", updated);
        setLastResult({ mirror, emotion, summary: null });

        // periodic summary in web mode
        if (updated.length % SUMMARY_EVERY === 0) {
          const slice = updated.slice(0, SUMMARY_EVERY);
          const text  = await callGroq(apiKey, summaryPrompt(slice));
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
    <>
      {/* ── Topbar ── */}
      <header className="topbar">
        <div className="topbar-brand">
          <h1>🪞 Echo</h1>
          <span>your voice, reflected</span>
        </div>

        <nav className="topbar-nav">
          {[["write","Write"],["entries","Entries"],["timeline","Timeline"],["summaries","Summaries"]].map(([id, label]) => (
            <button key={id} className={`topbar-btn ${tab===id?"active":""}`} onClick={() => setTab(id)}>{label}</button>
          ))}
        </nav>

        <div className="topbar-right">
          {pendingCount > 0 && (
            <span style={{ fontSize:11, padding:"3px 9px", borderRadius:20, background:"rgba(251,191,36,0.1)", color:"#fbbf24", border:"1px solid rgba(251,191,36,0.25)" }}>
              {pendingCount} pending
            </span>
          )}
          <span className="status-pill" style={{
            background:  isOnline ? "var(--green-bg)" : "var(--red-bg)",
            color:       isOnline ? "var(--green)"    : "var(--red)",
            borderColor: isOnline ? "rgba(74,222,128,0.25)" : "rgba(248,113,113,0.25)",
          }}>
            ● {isOnline ? (backendOk ? "local" : "web") : "offline"}
          </span>
          {webMode && (
            <button onClick={() => setShowKey(v => !v)} style={{ fontSize:12, padding:"5px 10px", borderRadius:7, border:"1px solid var(--border)", background:"var(--surface)", cursor:"pointer", color:"var(--text-dim)" }}>
              {apiKey ? "🔑 key set" : "🔑 API key"}
            </button>
          )}
        </div>
      </header>

      {/* ── Page content ── */}
      <div className="page">

        {webMode && showKey && (
          <div className="api-key-panel">
            <label>Groq API Key (stored in browser only)</label>
            <input type="password" value={apiKey}
              onChange={e => { setApiKey(e.target.value); localStorage.setItem("echo_groq_key", e.target.value); }}
              placeholder="gsk_..."
            />
          </div>
        )}

        {/* ── WRITE ── */}
        {tab === "write" && (
          <div>
            <h2 className="write-heading">What's on your mind?</h2>

            <div className="mode-tabs">
              {MIRROR_MODES.map(m => (
                <button key={m.key} className={`mode-tab ${mode===m.key?"active":""}`} onClick={() => setMode(m.key)} title={m.desc}>
                  {m.label}
                </button>
              ))}
            </div>

            <textarea className="journal-textarea" value={body} onChange={e => setBody(e.target.value)}
              placeholder="Start writing…"
              rows={10}
            />

            <div className="write-footer">
              <span className="word-count">{body.trim().split(/\s+/).filter(Boolean).length} words</span>
              <button className="submit-btn" onClick={submit} disabled={!canSubmit}>
                {loading ? <><Spinner/> Reflecting…</> : "Reflect →"}
              </button>
            </div>

            {lastResult && (
              <div className="result-box">
                <div className="emotion-chip">
                  <EmotionDot emotion={lastResult.emotion} size={8}/>
                  {lastResult.emotion}
                </div>
                {lastResult.mirror && <div className="mirror-block">{lastResult.mirror}</div>}
                {lastResult.summary && <div style={{ marginTop:16 }}><SummaryCard summary={lastResult.summary}/></div>}
              </div>
            )}
          </div>
        )}

        {/* ── ENTRIES ── */}
        {tab === "entries" && (
          <div>
            <div className="section-header">
              <h2 className="section-title">Your Entries</h2>
              {entries.length > 0 && <span className="count-badge">{entries.length}</span>}
            </div>
            {entries.length === 0
              ? <p className="empty-state">No entries yet. Write your first one.</p>
              : entries.map(e => <EntryCard key={e.id} entry={e} onDelete={deleteEntry}/>)
            }
          </div>
        )}

        {/* ── TIMELINE ── */}
        {tab === "timeline" && (
          <div>
            <div className="section-header">
              <h2 className="section-title">Mood Timeline</h2>
            </div>
            <MoodTimeline entries={entries}/>
          </div>
        )}

        {/* ── SUMMARIES ── */}
        {tab === "summaries" && (
          <div>
            <div className="section-header">
              <h2 className="section-title">Summaries</h2>
              {summaries.length > 0 && <span className="count-badge">{summaries.length}</span>}
            </div>
            {summaries.length === 0
              ? <p className="empty-state">Summaries appear every {SUMMARY_EVERY} entries.</p>
              : summaries.map((s, i) => <SummaryCard key={i} summary={s}/>)
            }
          </div>
        )}

      </div>

      {toast && <Toast msg={toast} onDone={() => setToast(null)}/>}
    </>
  );
}

