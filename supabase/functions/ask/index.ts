// Crypto Research Agent v2 — hybrid RAG + live market data
// Pipeline: rewrite -> coin detect -> market fetch -> hybrid search -> rerank -> generate
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DAILY_LIMIT = 50;
const CACHE_TTL_MS = 60_000;
const MIN_SIMILARITY = 0.35;

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function callLLM(body: unknown): Promise<Response> {
  return await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": LOVABLE_API_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function rewriteQuery(question: string): Promise<string> {
  try {
    const res = await callLLM({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content:
            "Rewrite the user's crypto question into a concise search query optimized for retrieval. Expand ticker symbols to full names (BTC -> Bitcoin, ETH -> Ethereum, SOL -> Solana), add 2-3 relevant keywords. Return ONLY the rewritten query, no quotes, no explanation, under 20 words.",
        },
        { role: "user", content: question },
      ],
    });
    if (!res.ok) return question;
    const j = await res.json();
    const out = j.choices?.[0]?.message?.content?.trim();
    return out && out.length > 3 ? out : question;
  } catch {
    return question;
  }
}

type Coin = { name: string; symbol: string; coingecko_id: string };

async function detectCoins(
  supabase: ReturnType<typeof createClient>,
  text: string,
): Promise<Coin[]> {
  const { data: registry } = await supabase
    .from("coin_registry")
    .select("name,symbol,coingecko_id,rank")
    .order("rank", { ascending: true });
  if (!registry) return [];

  const lc = text.toLowerCase();
  // word-boundary regex per coin
  const detected: Coin[] = [];
  for (const c of registry as any[]) {
    if (detected.length >= 2) break;
    const nameRe = new RegExp(`\\b${c.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    const symRe = new RegExp(`\\b${c.symbol.toLowerCase()}\\b`);
    if (nameRe.test(lc) || symRe.test(lc)) {
      detected.push({ name: c.name, symbol: c.symbol, coingecko_id: c.coingecko_id });
    }
  }
  return detected;
}

type MarketData = {
  coingecko_id: string;
  name: string;
  symbol: string;
  image: string;
  price: number;
  change_24h: number;
  change_7d: number;
  volume_24h: number;
  market_cap: number;
  series: { t: number; p: number }[];
};

async function fetchMarket(
  supabase: ReturnType<typeof createClient>,
  coin: Coin,
): Promise<MarketData | null> {
  const now = Date.now();
  const { data: cached } = await supabase
    .from("market_cache")
    .select("payload,fetched_at")
    .eq("coingecko_id", coin.coingecko_id)
    .maybeSingle();

  if (cached && now - new Date(cached.fetched_at).getTime() < CACHE_TTL_MS) {
    return cached.payload as MarketData;
  }

  try {
    const [coinRes, chartRes] = await Promise.all([
      fetch(
        `https://api.coingecko.com/api/v3/coins/${coin.coingecko_id}?localization=false&tickers=false&community_data=false&developer_data=false`,
      ),
      fetch(
        `https://api.coingecko.com/api/v3/coins/${coin.coingecko_id}/market_chart?vs_currency=usd&days=7&interval=hourly`,
      ),
    ]);
    if (!coinRes.ok || !chartRes.ok) return null;
    const c = await coinRes.json();
    const chart = await chartRes.json();
    const md: MarketData = {
      coingecko_id: coin.coingecko_id,
      name: c.name,
      symbol: (c.symbol || coin.symbol).toUpperCase(),
      image: c.image?.small || c.image?.thumb || "",
      price: c.market_data?.current_price?.usd ?? 0,
      change_24h: c.market_data?.price_change_percentage_24h ?? 0,
      change_7d: c.market_data?.price_change_percentage_7d ?? 0,
      volume_24h: c.market_data?.total_volume?.usd ?? 0,
      market_cap: c.market_data?.market_cap?.usd ?? 0,
      series: (chart.prices ?? []).map((p: [number, number]) => ({ t: p[0], p: p[1] })),
    };
    await supabase
      .from("market_cache")
      .upsert({ coingecko_id: coin.coingecko_id, payload: md, fetched_at: new Date().toISOString() });
    return md;
  } catch (e) {
    console.error("coingecko fetch failed", coin.coingecko_id, e);
    return null;
  }
}

async function embedText(text: string): Promise<number[] | null> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": LOVABLE_API_KEY,
    },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.data?.[0]?.embedding ?? null;
}

async function rerank(
  question: string,
  candidates: any[],
): Promise<string[]> {
  if (candidates.length <= 5) return candidates.map((c) => c.id);
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. id=${c.id} | ${c.article_title}\n${(c.chunk_text || "").slice(0, 300)}`,
    )
    .join("\n\n");
  try {
    const res = await callLLM({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content:
            'You are a search reranker. Given a user question and numbered candidate news chunks, return ONLY a JSON object of the form {"ids":["id1","id2","id3","id4","id5"]} listing the 5 most relevant chunk ids in order of relevance. No markdown, no explanation.',
        },
        {
          role: "user",
          content: `Question: ${question}\n\nCandidates:\n${list}`,
        },
      ],
    });
    if (!res.ok) return candidates.slice(0, 5).map((c) => c.id);
    const j = await res.json();
    const raw = j.choices?.[0]?.message?.content ?? "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return candidates.slice(0, 5).map((c) => c.id);
    const parsed = JSON.parse(match[0]);
    const ids = (parsed.ids ?? []).filter((x: any) => typeof x === "string").slice(0, 5);
    return ids.length > 0 ? ids : candidates.slice(0, 5).map((c) => c.id);
  } catch {
    return candidates.slice(0, 5).map((c) => c.id);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { question } = await req.json();
    if (!question || typeof question !== "string" || question.length > 500) {
      return new Response(JSON.stringify({ error: "invalid question" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
    const today = new Date().toISOString().slice(0, 10);

    const { data: usage } = await supabase
      .from("demo_usage")
      .select("query_count")
      .eq("date", today)
      .maybeSingle();
    const count = (usage as any)?.query_count ?? 0;
    if (count >= DAILY_LIMIT) {
      return new Response(JSON.stringify({ error: "limit" }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    await supabase
      .from("demo_usage")
      .upsert(
        { date: today, query_count: count + 1, updated_at: new Date().toISOString() },
        { onConflict: "date" },
      );

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const emit = (event: string, data: unknown) =>
          controller.enqueue(enc.encode(sse(event, data)));

        try {
          // 1. Rewrite
          emit("stage", { id: "rewrite" });
          const rewritten = await rewriteQuery(question);
          emit("rewrite", { query: rewritten });

          // 2. Coin detect
          emit("stage", { id: "coin_detect" });
          let coins = await detectCoins(supabase, `${question} ${rewritten}`);
          if (coins.length === 0) {
            coins = [{ name: "Bitcoin", symbol: "BTC", coingecko_id: "bitcoin" }];
          }
          emit("coins", { coins });

          // 3. Market data (parallel)
          emit("stage", { id: "market" });
          const markets = (
            await Promise.all(coins.map((c) => fetchMarket(supabase, c)))
          ).filter((m): m is MarketData => !!m);
          emit("market", { markets });

          // 4. Hybrid search
          emit("stage", { id: "hybrid_search" });
          const qEmbedding = await embedText(rewritten);
          const [vecRes, ftsRes] = await Promise.all([
            qEmbedding
              ? supabase.rpc("match_news_chunks", {
                  query_embedding: qEmbedding,
                  match_count: 8,
                })
              : Promise.resolve({ data: [], error: null } as any),
            supabase.rpc("search_news_fts", { query_text: rewritten, match_count: 8 }),
          ]);
          const vecRows = (vecRes.data ?? []) as any[];
          const ftsRows = (ftsRes.data ?? []) as any[];

          const merged = new Map<string, any>();
          for (const r of vecRows) merged.set(r.id, { ...r, similarity: r.similarity });
          for (const r of ftsRows) {
            const existing = merged.get(r.id);
            if (existing) continue;
            merged.set(r.id, { ...r, similarity: 0 }); // no vector score
          }
          const candidates = Array.from(merged.values());
          const bestSim = vecRows.reduce((m, r) => Math.max(m, r.similarity ?? 0), 0);
          emit("candidates", { count: candidates.length, best_similarity: bestSim });

          // Threshold: honest fallback if we have no vector hits above threshold
          if (bestSim < MIN_SIMILARITY || candidates.length === 0) {
            emit("no_results", {
              best_similarity: bestSim,
              message:
                "No sufficiently relevant sources found in the last 7 days for this question.",
            });
            emit("done", {});
            controller.close();
            return;
          }

          // 5. Rerank
          emit("stage", { id: "rerank" });
          const keepIds = await rerank(question, candidates);
          const byId = new Map(candidates.map((c) => [c.id, c]));
          const finalSources = keepIds
            .map((id) => byId.get(id))
            .filter(Boolean)
            .slice(0, 5);
          emit("rerank", { from: candidates.length, to: finalSources.length });

          if (finalSources.length === 0) {
            emit("no_results", { best_similarity: bestSim, message: "Reranker returned no sources." });
            emit("done", {});
            controller.close();
            return;
          }

          emit("sources", {
            sources: finalSources.map((s: any) => ({
              title: s.article_title,
              url: s.article_url,
              source_name: s.source_name,
              published_at: s.published_at,
              similarity: s.similarity ?? 0,
            })),
          });

          // 6. Generate
          emit("stage", { id: "generate" });

          const marketBlock =
            markets.length > 0
              ? `[M] Market data (live, CoinGecko):\n` +
                markets
                  .map(
                    (m) =>
                      `- ${m.name} (${m.symbol}): price $${m.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}, 24h ${m.change_24h.toFixed(2)}%, 7d ${m.change_7d.toFixed(2)}%, volume $${m.volume_24h.toLocaleString()}, market cap $${m.market_cap.toLocaleString()}`,
                  )
                  .join("\n")
              : "";

          const numbered = finalSources
            .map(
              (s: any, i: number) =>
                `[${i + 1}] (${s.source_name}, ${new Date(s.published_at).toDateString()})\n${s.chunk_text}`,
            )
            .join("\n\n");

          const systemPrompt =
            "You have two source types: live market data [M] and news sources [1..n]. Ground quantitative claims (price moves, percentages) in [M] and qualitative claims (reasons, events, sentiment) in the news sources. Always state the actual price change numbers when relevant. Cite every claim. Keep answers under 200 words. Never give financial advice.";

          const chatRes = await callLLM({
            model: "google/gemini-2.5-flash",
            stream: true,
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `Question: ${question}\n\n${marketBlock}\n\nNews sources:\n${numbered}`,
              },
            ],
          });

          if (!chatRes.ok || !chatRes.body) {
            emit("token", { text: `\n\n[Error contacting model: ${chatRes.status}]` });
            emit("done", {});
            controller.close();
            return;
          }

          const reader = chatRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data:")) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") continue;
              try {
                const chunk = JSON.parse(payload);
                const delta = chunk.choices?.[0]?.delta?.content;
                if (delta) emit("token", { text: delta });
              } catch {
                /* ignore */
              }
            }
          }

          emit("done", { best_similarity: bestSim });
          controller.close();
        } catch (e) {
          console.error("ask pipeline error", e);
          emit("error", { message: String(e) });
          emit("done", {});
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (e) {
    console.error("ask error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
