# Echo

A reflective journaling app. Write an entry — Echo mirrors it back through rewrites, questions, or continuations, tags your emotion, tracks your mood over time, and periodically surfaces recurring themes.

Powered by **Gemini**. Runs fully locally or in the browser.

## Features

| Feature | Description |
|---|---|
| Mirror modes | Reflect (rewrite), Question (gentle prompts), Continue (extend your voice) |
| Emotional tagging | Gemini detects the dominant emotion per entry |
| Mood timeline | Visual dot timeline of emotions across all entries |
| Theme summaries | Gemini writes a warm summary every N entries |
| Dual mode | Local (Flask + SQLite) or web-only (Gemini direct from browser) |
| Offline-first | Entries cached to IndexedDB when offline, synced when back online |

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, Vite |
| Backend | Python 3.11+, Flask |
| Database | SQLite (local) / localStorage + IndexedDB (web) |
| AI | Google Gemini 1.5 Flash |

## Quick Start

### Local mode (Flask + SQLite)

```bash
# 1. Backend
cd server
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env   # add your GEMINI_API_KEY
python app.py             # → http://localhost:5050

# 2. Frontend (separate terminal)
cd ..
npm install
npm run dev               # → http://localhost:5173
```

### Web-only mode (no backend)

```bash
npm install
npm run dev
```

Open the app, click **🔑 API key**, paste your Gemini key. Everything runs in the browser — no server needed. Entries live in `localStorage` and `IndexedDB`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | — | Gemini API key (server-side) |
| `SUMMARY_EVERY` | `5` | Entries between theme summaries |
| `PORT` | `5050` | Flask port |
| `VITE_API_BASE` | `http://localhost:5050` | Backend URL (leave empty for web-only) |

## Offline Behaviour

When the backend is unreachable or the device is offline, entries are saved to **IndexedDB**. When the connection is restored, the app automatically syncs all pending entries to the backend (with Gemini processing) and clears the local cache.

## API

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/entries` | Create entry (triggers mirror + tag) |
| GET | `/api/entries` | List entries |
| DELETE | `/api/entries/:id` | Delete entry |
| GET | `/api/summaries` | List theme summaries |
| GET | `/api/mood-timeline` | Emotion + timestamp for each entry |
| POST | `/api/sync` | Bulk sync offline entries |
| GET | `/api/health` | Health check |
