"""
Echo — Flask backend
Handles: entry storage, Gemini mirroring, emotional tagging, theme summaries.
Gemini is called server-side using GEMINI_API_KEY from .env.
"""

import json, os, sqlite3, time
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app  = Flask(__name__)
CORS(app)

ROOT         = Path(__file__).parent
DB_PATH      = ROOT / "echo.db"
SCHEMA       = ROOT / "schema.sql"
GEMINI_KEY   = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-1.5-flash"
SUMMARY_EVERY = int(os.environ.get("SUMMARY_EVERY", "15"))

EMOTIONS = ["joy","sadness","anger","fear","disgust","surprise","anxiety","love","grief","hope","shame","pride","neutral"]

# ── DB ────────────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.executescript(SCHEMA.read_text())

# ── Gemini ────────────────────────────────────────────────────────────────────

def gemini(prompt: str) -> str:
    if not GEMINI_KEY:
        return ""
    import urllib.request, urllib.error
    url  = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_KEY}"
    body = json.dumps({"contents": [{"parts": [{"text": prompt}]}]}).encode()
    req  = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())["candidates"][0]["content"]["parts"][0]["text"].strip()
    except Exception:
        return ""

# ── Prompts ───────────────────────────────────────────────────────────────────

def _tone_note(body: str) -> str:
    words      = body.split()
    avg_len    = sum(len(w) for w in words) / max(len(words), 1)
    sentences  = [s.strip() for s in body.replace("?",".|").replace("!",".|").split(".") if s.strip()]
    avg_sent   = len(words) / max(len(sentences), 1)
    has_questions = "?" in body
    informal   = any(w in body.lower() for w in ["i'm","i've","i'd","can't","don't","it's","gonna","kinda","sorta"])

    if avg_sent < 8 and informal:
        return "The writer uses short, casual sentences. Match that rhythm — keep your response brief and conversational, not formal."
    if avg_len > 6 and avg_sent > 20:
        return "The writer uses long, considered sentences with rich vocabulary. Match that register — write with care and some complexity."
    if has_questions:
        return "The writer is already questioning themselves. Honour that uncertainty — don't resolve it, sit with it."
    return "Match the writer's natural voice — don't be more formal or more casual than they are."

_DARK_SIGNALS = [
    "don't want to be here","don't want to exist","want to disappear","want to die",
    "end it","end my life","kill myself","killing myself","no reason to live",
    "can't go on","can't do this anymore","nobody would miss me","better off without me",
    "worthless","hopeless","nothing matters","give up on everything","can't feel anything",
    "numb to everything","completely empty","falling apart","breaking down",
]

def _is_dark(body: str) -> bool:
    b = body.lower()
    return any(signal in b for signal in _DARK_SIGNALS)

_DARK_PREAMBLE = """IMPORTANT CONTEXT: This entry contains language that suggests the writer may be in significant emotional pain or distress.

Your response must:
- Be quieter and slower than usual — no warmth that feels performative
- Acknowledge the weight of what they wrote without minimising or rushing past it
- Not offer solutions, reframes, or silver linings of any kind
- Not use words like "journey", "growth", "strength", or "healing"
- If the entry contains any hint of self-harm or not wanting to exist, end your response with this exact line on its own paragraph:
  "If you're in crisis, you don't have to carry this alone. You can reach the 988 Suicide & Crisis Lifeline by calling or texting 988."
- Otherwise, simply bear witness. Sometimes the most honest thing is to say: this is heavy, and you don't have to explain it.

"""

def mirror_prompt(body: str, mode: str) -> str:
    tone = _tone_note(body)
    dark = _is_dark(body)
    preamble = _DARK_PREAMBLE if dark else ""

    if mode == "rewrite":
        return f"""{preamble}You are a compassionate journaling companion. Your task is to gently reflect this journal entry back to the writer in second person — as if a trusted friend who truly listened is now speaking.

Tone guidance: {tone}

Rules:
- Preserve every emotional truth, even the painful ones. Do not minimise or fix.
- Soften harsh self-criticism without erasing it — transform "I'm a failure" into "you've been carrying a heavy sense of not being enough."
- Do not add advice, silver linings, or conclusions the writer didn't reach themselves.
- Write in flowing prose, same approximate length as the original.
- Begin mid-thought, not with "You wrote…" or "It sounds like…"

Journal entry:
{body}"""

    if mode == "question":
        return f"""{preamble}You are a gentle journaling companion. Read this entry carefully, then offer 2–3 open questions that invite the writer to go one layer deeper.

Tone guidance: {tone}

Rules:
- Ask only — never interpret, advise, or summarise.
- Each question should open a door, not close one. Avoid yes/no questions.
- Questions should feel like they come from someone who read every word, not a generic prompt.
- Space them on separate lines. No preamble, no closing remark.
- If the entry is already asking questions, ask questions about those questions.

Journal entry:
{body}"""

    if mode == "continuation":
        if dark:
            # Don't continue dark entries — reflect instead
            return mirror_prompt(body, "rewrite")
        return f"""You are a ghostwriter who has just read this journal entry. Continue it in the writer's exact voice — same sentence rhythm, same vocabulary register, same emotional temperature.

Tone guidance: {tone}

Rules:
- Write 3–5 sentences. No more.
- Do not resolve anything the writer left unresolved. Do not introduce new topics.
- Do not begin with "And" or repeat the last sentence.
- The continuation should feel like the writer kept going, not like someone else took over.
- If the entry ends mid-thought, continue that thought.

Journal entry:
{body}"""

    return mirror_prompt(body, "rewrite")


def tag_prompt(body):
    return (f"Identify the single dominant emotion in this journal entry. "
            f"Choose exactly one from: {', '.join(EMOTIONS)}. Reply with only the emotion word.\n\n{body}")

def summary_prompt(entries):
    block = "\n\n---\n\n".join(f"[{i+1}] {e['body']}" for i, e in enumerate(entries))
    return f"""You are a thoughtful journaling companion who has been reading someone's private journal over time.

Read these {len(entries)} entries and write a warm, personal summary (2–3 paragraphs) that:
- Names the recurring themes you noticed, without labelling them clinically
- Reflects any emotional shifts or patterns across the entries
- Notices what the writer keeps returning to, even indirectly
- Speaks directly to the writer in second person, as a trusted witness — not a therapist

Do not list bullet points. Do not give advice. Do not be cheerful if the entries aren't.
Write as if you genuinely know this person.

Entries:
{block}"""

# ── Helpers ───────────────────────────────────────────────────────────────────

def process_entry(body, mode, ts=None):
    emotion = gemini(tag_prompt(body)).lower().strip()
    if emotion not in EMOTIONS:
        emotion = "neutral"
    mirror = gemini(mirror_prompt(body, mode))
    now    = ts or time.time()
    return emotion, mirror, now

def maybe_summary(conn, count):
    if count % SUMMARY_EVERY != 0:
        return None
    rows = conn.execute(
        f"SELECT body FROM entries ORDER BY created_at DESC LIMIT {SUMMARY_EVERY}"
    ).fetchall()
    text = gemini(summary_prompt([dict(r) for r in reversed(rows)]))
    if not text:
        return None
    rng = f"{count - SUMMARY_EVERY + 1}–{count}"
    conn.execute("INSERT INTO summaries (created_at, entry_range, content) VALUES (?,?,?)",
                 (time.time(), rng, text))
    return {"range": rng, "content": text}

# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/api/health")
def health():
    return jsonify({"ok": True, "gemini": bool(GEMINI_KEY), "summary_every": SUMMARY_EVERY})

@app.route("/api/entries", methods=["GET"])
def list_entries():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM entries ORDER BY created_at DESC LIMIT 100").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/entries", methods=["POST"])
def create_entry():
    data = request.get_json()
    body = data.get("body", "").strip()
    mode = data.get("mirror_mode", "rewrite")
    if not body:
        return jsonify({"error": "body required"}), 400

    emotion, mirror, now = process_entry(body, mode)
    tags = json.dumps(data.get("tags", []))

    with get_db() as conn:
        cur = conn.execute(
            "INSERT INTO entries (created_at, body, emotion, mirror_mode, mirror, tags) VALUES (?,?,?,?,?,?)",
            (now, body, emotion, mode, mirror, tags)
        )
        entry_id = cur.lastrowid
        count    = conn.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        summary  = maybe_summary(conn, count)

    return jsonify({"id": entry_id, "created_at": now, "body": body,
                    "emotion": emotion, "mirror_mode": mode, "mirror": mirror,
                    "tags": tags, "summary": summary})

@app.route("/api/entries/<int:eid>", methods=["DELETE"])
def delete_entry(eid):
    with get_db() as conn:
        conn.execute("DELETE FROM entries WHERE id=?", (eid,))
    return jsonify({"deleted": eid})

@app.route("/api/summaries", methods=["GET"])
def list_summaries():
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM summaries ORDER BY created_at DESC").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/mood-timeline", methods=["GET"])
def mood_timeline():
    with get_db() as conn:
        rows = conn.execute("SELECT created_at, emotion FROM entries ORDER BY created_at ASC").fetchall()
    return jsonify([dict(r) for r in rows])

@app.route("/api/sync", methods=["POST"])
def sync():
    """Offline-first: frontend posts cached entries when back online."""
    entries = request.get_json().get("entries", [])
    synced  = []
    for e in entries:
        body = e.get("body", "").strip()
        mode = e.get("mirror_mode", "rewrite")
        if not body:
            continue
        emotion, mirror, now = process_entry(body, mode, ts=e.get("created_at"))
        tags = json.dumps(e.get("tags", []))
        with get_db() as conn:
            cur = conn.execute(
                "INSERT INTO entries (created_at, body, emotion, mirror_mode, mirror, tags) VALUES (?,?,?,?,?,?)",
                (now, body, emotion, mode, mirror, tags)
            )
            synced.append(cur.lastrowid)
    return jsonify({"synced": len(synced), "ids": synced})

if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", 5050))
    print(f"  Echo API → http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, debug=True)
