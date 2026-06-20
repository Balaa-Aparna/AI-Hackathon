# Doc Prompt

A minimal skeleton for a document upload + prompting app.

- **backend/** — FastAPI: upload documents, list them, send a prompt (LLM call is stubbed).
- **frontend/** — React (Vite): upload UI, document picker, prompt box.

## Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload   # http://localhost:8000  (docs at /docs)
```

## Frontend

Requires Node.js (not currently installed — e.g. `brew install node`).

```bash
cd frontend
npm install
npm run dev   # http://localhost:5173
```

The Vite dev server proxies `/api/*` to the backend on port 8000.

## Endpoints

| Method | Path             | Description                          |
| ------ | ---------------- | ------------------------------------ |
| GET    | `/api/health`    | Health check                         |
| GET    | `/api/documents` | List uploaded documents              |
| POST   | `/api/upload`    | Upload a file (multipart `file`)     |
| POST   | `/api/prompt`    | `{ prompt, document_id }` → `answer` |

## Next steps

- Replace the stubbed answer in `backend/main.py` (`/api/prompt`) with a real LLM call.
- Add parsing for non-text files (PDF, docx) in `/api/upload`.
- Persist documents instead of the in-memory `DOCUMENTS` dict.
