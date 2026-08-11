// Fetch crypto news from public RSS feeds, embed via Lovable AI Gateway,
// upsert into news_chunks, prune rows older than 7 days.
// Requires CRON_SECRET header (x-cron-secret) to invoke.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FEEDS: { url: string; source: string }[] = [
  { url: "https://cointelegraph.com/rss", source: "Cointelegraph" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "CoinDesk" },
  { url: "https://decrypt.co/feed", source: "Decrypt" },
  { url: "https://bitcoinmagazine.com/.rss/full/", source: "Bitcoin Magazine" },
];

function stripHtml(s: string) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function pick(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? stripHtml(m[1]) : "";
}

type Article = {
  title: string;
  url: string;
  source: string;
  published_at: string;
  body: string;
};

async function fetchFeed(feed: { url: string; source: string }): Promise<Article[]> {
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": "Mozilla/5.0 CryptoResearchBot" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item[\s\S]*?<\/item>/gi) ?? [];
    return items.slice(0, 15).map((item) => {
      const title = pick(item, "title");
      const link = pick(item, "link");
      const desc = pick(item, "description");
      const contentEncoded = pick(item, "content:encoded");
      const pub = pick(item, "pubDate");
      let publishedAt = new Date().toISOString();
      if (pub) {
        const d = new Date(pub);
        if (!isNaN(d.getTime())) publishedAt = d.toISOString();
      }
      return {
        title,
        url: link,
        source: feed.source,
        published_at: publishedAt,
        body: (contentEncoded || desc || "").slice(0, 1200),
      };
    }).filter((a) => a.title && a.url);
  } catch (e) {
    console.error(`feed ${feed.source} failed:`, e);
    return [];
  }
}

async function embed(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": LOVABLE_API_KEY,
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: texts,
    }),
  });
  if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.data.map((d: any) => d.embedding);
}

// Constant-time string comparison to prevent timing attacks
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Require a shared cron secret. This endpoint runs the service role and makes
  // paid outbound calls, so it must never be publicly invokable.
  const CRON_SECRET = Deno.env.get("CRON_SECRET");
  const provided =
    req.headers.get("x-cron-secret") ??
    (req.headers.get("authorization")?.startsWith("Bearer ")
      ? req.headers.get("authorization")!.slice(7)
      : "");
  if (!CRON_SECRET || !provided || !safeEqual(provided, CRON_SECRET)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1. Fetch all feeds in parallel
    const results = await Promise.all(FEEDS.map(fetchFeed));
    const articles = results.flat();

    // 2. Dedupe against existing
    const urls = articles.map((a) => a.url);
    const { data: existing } = await supabase
      .from("news_chunks")
      .select("article_url")
      .in("article_url", urls);
    const existingSet = new Set((existing ?? []).map((e: any) => e.article_url));
    const fresh = articles.filter((a) => !existingSet.has(a.url)).slice(0, 40);

    let inserted = 0;
    if (fresh.length > 0) {
      const chunks = fresh.map((a) => `${a.title}\n\n${a.body}`);

      // batch embed in groups of 20
      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += 20) {
        const batch = chunks.slice(i, i + 20);
        const vecs = await embed(batch);
        embeddings.push(...vecs);
      }

      const rows = fresh.map((a, i) => ({
        article_title: a.title,
        article_url: a.url,
        source_name: a.source,
        published_at: a.published_at,
        chunk_text: chunks[i],
        embedding: embeddings[i],
      }));

      const { error } = await supabase
        .from("news_chunks")
        .upsert(rows, { onConflict: "article_url" });
      if (error) throw error;
      inserted = rows.length;
    }

    // 3. Prune old
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("news_chunks").delete().lt("created_at", cutoff);

    // 4. Rebuild embedding map cache (fire and forget-ish; log errors)
    try {
      const rebuildRes = await fetch(`${SUPABASE_URL}/functions/v1/embedding-map`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cron-secret": CRON_SECRET,
        },
        body: JSON.stringify({ action: "rebuild" }),
      });
      if (!rebuildRes.ok) {
        console.error("embedding-map rebuild failed:", rebuildRes.status, await rebuildRes.text());
      }
    } catch (e) {
      console.error("embedding-map rebuild error:", e);
    }

    return new Response(
      JSON.stringify({ ok: true, fetched: articles.length, inserted }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("ingest-news error:", e);
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
