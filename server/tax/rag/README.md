# CaiShen Tax-Law RAG

Retrieval layer for the tax advisor. The AI never relies on "knowing" tax law from
training — it answers from **current, retrieved IRS/state sources**, with citations.

## Architecture

```
question ──▶ embed (Ollama) ──▶ search (Qdrant) ──▶ ranked excerpts ──▶ AI prompt
                                      ▲
                          metadata filter ALWAYS enforces:
                          • is_current_law = true   (never superseded law)
                          • tax_year match OR year-agnostic
                          • federal OR user's state
```

| Piece | Tech | Why |
|---|---|---|
| Embeddings | Ollama `nomic-embed-text` (768-dim) | Free, local, CPU-friendly, private |
| Vector store | Qdrant (Docker) | Fast filtered search, easy self-host |
| Source registry | Postgres `tax_sources` | Year/jurisdiction/supersede metadata |

## One-time setup

**1. Start Qdrant**
```
docker compose -f server/rag/docker-compose.yml up -d
```

**2. Install Ollama + embedding model** (https://ollama.com)
```
ollama pull nomic-embed-text
```

**3. Configure `.env`** (see `.env.example`)
```
OLLAMA_URL=http://localhost:11434
EMBED_MODEL=nomic-embed-text
EMBED_DIM=768
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=tax_sources
```

**4. Seed the starter corpus**
```
node server/rag/seed.js
```

## Verify

```
curl http://localhost:3001/api/rag/status   # (with auth header)
```
`ready: true` means Ollama + Qdrant are both up.

## API

| Method | Route | Auth | Purpose |
|---|---|---|---|
| GET | `/api/rag/status` | user | Health + corpus stats |
| POST | `/api/rag/retrieve` | user | `{query, taxYear?, jurisdiction?, topK?}` → excerpts |
| GET | `/api/rag/sources` | user | List registered sources |
| POST | `/api/rag/ingest` | admin | Ingest one document |
| POST | `/api/rag/sources/:id/supersede` | admin | Mark no-longer-current |
| DELETE | `/api/rag/sources/:id` | admin | Remove a source |

## Keeping current

- **Annual refresh**: when the engine's `data.js` numbers update for a new tax year,
  re-ingest the year-specific seed docs (or add the new IRS PDFs). Stable `sourceKey`
  values mean re-ingesting **replaces** rather than duplicates.
- **Superseded guidance**: `POST /sources/:id/supersede` flips `is_current_law=false`
  on both the Postgres row and the Qdrant payloads, so it drops out of retrieval but
  stays for audit history.

## Production ingestion (beyond the seed)

The seed is a curated starter set. For full coverage, build ingestion jobs that pull
official PDFs/HTML and call `ingestDocument()`:
- IRS Publications — irs.gov/publications (annual)
- Internal Revenue Code — uscode.house.gov (Title 26)
- Treasury Regulations — ecfr.gov (26 CFR)
- IRS Notices / Revenue Rulings — irs.gov/irb (weekly)
- State guidance — each state's DOR site

IRS works are public domain (17 U.S.C. § 105).
