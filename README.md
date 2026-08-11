# Crypto Research Agent

A hybrid **RAG + live market data** research agent for crypto questions. It rewrites the user's
question, detects which coins are involved, pulls live prices from CoinGecko, searches a 7-day
news corpus with **vector + full-text hybrid search**, reranks the results with an LLM, and streams
a cited answer over SSE.

Extracted from my portfolio site (kamkar-ai.com) so it can be developed further as a standalone project.

## Pipeline

```
question
  -> rewrite (gemini-2.5-flash)
  -> coin detection (coin_registry, word-boundary match)
  -> live market data (CoinGecko, 60s cache in market_cache)
  -> hybrid retrieval (pgvector cosine + Postgres FTS)
  -> similarity threshold (0.35) -> honest "no results" fallback
  -> LLM rerank -> top 5 chunks
  -> streamed answer with [1..n] citations + [M] market grounding
```

Every stage is emitted as an SSE event (`stage`, `rewrite`, `coins`, `market`, `candidates`,
`sources`, `token`, `done`), so the UI can show the agent thinking in real time.

## Stack

- **Frontend:** React + TypeScript + Vite + Tailwind, framer-motion, Recharts
- **Backend:** Supabase Edge Functions (Deno)
- **Data:** Postgres + pgvector, `tsvector` full-text index
- **Models:** `google/gemini-2.5-flash` (rewrite, rerank, generation), `openai/text-embedding-3-small` (embeddings) via the Lovable AI Gateway
- **Market data:** CoinGecko public API

## Layout

```
src/pages/CryptoResearchAgent.tsx   # UI: SSE consumer, pipeline visualiser, chat
src/components/MarketCoinCard.tsx   # live price card + 7d sparkline
src/components/SourceRelevanceChart.tsx
supabase/functions/ask/             # the agent pipeline (SSE)
supabase/functions/ingest-news/     # RSS ingest -> chunk -> embed -> store
supabase/migrations/                # tables, pgvector index, RPCs
```

## Tables

| table | purpose |
|---|---|
| `news_articles` / `news_chunks` | ingested articles, chunked + embedded |
| `coin_registry` | coin name/symbol -> coingecko_id, ranked |
| `market_cache` | 60s CoinGecko response cache |
| `demo_usage` | daily query budget (50/day) |

RPCs: `match_news_chunks` (vector search), `search_news_fts` (full-text search).

All of these tables are **server-only**: RLS is on with no public policies and the edge functions
reach them with the service role key.

## Environment

Edge functions expect:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
LOVABLE_API_KEY        # AI gateway (chat + embeddings)
```

## Running locally

```sh
npm i
npx supabase db push
npx supabase functions deploy ask ingest-news
npm run dev
```

Schedule `ingest-news` (cron, every ~30 min) to keep the corpus fresh.

## Ideas / next steps

- More sources + dedup across outlets
- Per-user rate limiting instead of a global daily budget
- Longer horizon corpus (30d) with recency-weighted scoring
- On-chain metrics as a third grounding source
