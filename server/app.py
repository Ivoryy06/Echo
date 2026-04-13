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
SUMMARY_EVERY = int(os.environ.get("SUMMARY_EVERY", "5"))

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

MIRROR_PROMPTS = {
    "rewrite":      lambda b: f"Gently rewrite this journal entry in second person, as if a compassionate friend is reflecting it back. Keep the emotional truth but soften harsh self-judgment.\n\n{b}",
    "question":     lambda b: f"Read this journal entry and respond with 2–3 gentle open-ended questions that invite deeper reflection. Don't interpret or advise — only ask.\n\n{b}",
    "continuation": lambda b: f"Continue this journal entry in the same voice and emotional register, as if the writer kept going. Write 2–4 sentences.\n\n{b}",
}

def tag_prompt(body):
    return (f"Identify the single dominant emotion in this journal entry. "
            f"Choose exactly one from: {', '.join(EMOTIONS)}. Reply with only the emotion word.\n\n{body}")

def summary_prompt(entries):
    block = "\n\n---\n\n".join(f"[{i+1}] {e['body']}" for i, e in enumerate(entries))
    return ("You are a thoughtful journaling companion. Read these journal entries and write a warm "
            "2–3 paragraph summary identifying recurring themes, emotional patterns, and shifts in "
            "perspective. Speak directly to the writer in second person. Be gentle, not clinical.\n\n" + block)

# ── Helpers ───────────────────────────────────────────────────────────────────

def process_entry(body, mode, ts=None):
    emotion = gemini(tag_prompt(body)).lower().strip()
    if emotion not in EMOTIONS:
        emotion = "neutral"
    mirror = gemini(MIRROR_PROMPTS.get(mode, MIRROR_PROMPTS["rewrite"])(body))
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
