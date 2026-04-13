# Echo

A reflective journaling app. Write an entry — Echo mirrors it back through rewrites, questions, or continuations, tags your emotion, tracks your mood over time, and periodically surfaces recurring themes.

Powered by **Groq (Llama 3)**. Runs fully locally or in the browser.

## Features

| Feature | Description |
|---|---|
| Mirror modes | Reflect (rewrite), Question (gentle prompts), Continue (extend your voice) |
| Emotional tagging | Groq detects the dominant emotion per entry |
| Mood timeline | Visual dot timeline of emotions across all entries |
| Theme summaries | Groq writes a warm summary every N entries |
| Dual mode | Local (Flask + SQLite) or web-only (Groq direct from browser) |
| Offline-first | Entries cached to IndexedDB when offline, synced when back online |

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, Vite |
| Backend | Python 3.11+, Flask |
| Database | SQLite (local) / localStorage + IndexedDB (web) |
| AI | Groq — Llama 3 8B |

## Quick Start

### Local mode (Flask + SQLite)

```bash
# 1. Backend
cd server
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env   # add your GROQ_API_KEY
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

Open the app, click **API key**, paste your Groq key (`gsk_...`). Get one free at [console.groq.com](https://console.groq.com). Everything runs in the browser — no server needed.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `GROQ_API_KEY` | — | Groq API key (server-side) |
| `SUMMARY_EVERY` | `15` | Entries between theme summaries |
| `PORT` | `5050` | Flask port |
| `VITE_API_BASE` | `http://localhost:5050` | Backend URL (leave empty for web-only) |

## Offline Behaviour

When the backend is unreachable or the device is offline, entries are saved to **IndexedDB**. When the connection is restored, the app automatically syncs all pending entries to the backend and clears the local cache.

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

## License

MIT
