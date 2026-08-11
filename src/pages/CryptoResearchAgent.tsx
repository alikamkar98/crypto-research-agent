import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ExternalLink,
  RotateCcw,
  Send,
  Loader2,
  BarChart3,
  AlertTriangle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import MarketCoinCard, { type MarketData } from "@/components/MarketCoinCard";
import SourceRelevanceChart from "@/components/SourceRelevanceChart";
import EmbeddingSpaceExplorer from "@/components/EmbeddingSpaceExplorer";
import WhyEmbeddingsMatter from "@/components/WhyEmbeddingsMatter";

const EXAMPLES = [
  "Why did Bitcoin move this week?",
  "What's the latest news on Ethereum ETFs?",
  "What's the market sentiment on Solana?",
];

const STAGES = [
  { id: "rewrite", label: "Rewriting query" },
  { id: "hybrid_search", label: "Hybrid search" },
  { id: "rerank", label: "Reranking" },
  { id: "market", label: "Market data" },
  { id: "generate", label: "Generating answer" },
] as const;

const HOW_IT_WORKS = [
  { t: "Rewrite + Detect", d: "One fast LLM pass rewrites the question for retrieval and detects which coins are mentioned against a top-100 registry." },
  { t: "Hybrid Search", d: "Runs pgvector cosine search and Postgres full-text search in parallel over the last 7 days of crypto news, then merges candidates." },
  { t: "Rerank + Market", d: "An LLM reranker picks the 5 most relevant chunks. In parallel, live prices and 7-day series are fetched from CoinGecko (60s cache)." },
  { t: "Generate", d: "Gemini 2.5 Flash streams a grounded answer citing news [n] and market data [M] over SSE." },
];

type Source = {
  title: string;
  url: string;
  source_name: string;
  published_at: string;
  similarity: number;
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const ANON = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;

type StageId = (typeof STAGES)[number]["id"];

const MIN_STAGE_MS = 1400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const CryptoResearchAgent = () => {
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<{ count: number; last: string | null }>({ count: 0, last: null });
  const [running, setRunning] = useState(false);
  const [activeStage, setActiveStage] = useState<StageId | null>(null);
  const [completedStages, setCompletedStages] = useState<Set<StageId>>(new Set());
  const [stageDetails, setStageDetails] = useState<Record<string, string>>({});
  const [rewriteTyped, setRewriteTyped] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [markets, setMarkets] = useState<MarketData[]>([]);
  const [bestSim, setBestSim] = useState<number | null>(null);
  const [noResults, setNoResults] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showArch, setShowArch] = useState(false);
  const sourceRefs = useRef<(HTMLDivElement | null)[]>([]);
  const demoRef = useRef<HTMLDivElement | null>(null);
  const stageStartRef = useRef<number>(0);

  // Typewriter effect for the rewritten query
  useEffect(() => {
    const full = stageDetails.rewrite ?? "";
    if (!full) { setRewriteTyped(""); return; }
    if (prefersReducedMotion()) { setRewriteTyped(full); return; }
    setRewriteTyped("");
    let i = 0;
    const step = () => {
      i++;
      setRewriteTyped(full.slice(0, i));
      if (i < full.length) timer = setTimeout(step, 22);
    };
    let timer = setTimeout(step, 22);
    return () => clearTimeout(timer);
  }, [stageDetails.rewrite]);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("news_index_status");
      if (error) {
        console.error("news_index_status failed:", error);
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      setStatus({
        count: Number(row?.total ?? 0),
        last: row?.latest ?? null,
      });
    })();
  }, [running]);

  useEffect(() => {
    if (window.location.hash === "#demo" && demoRef.current) {
      demoRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, []);

  function completeStage(id: StageId) {
    setCompletedStages((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }

  async function runAsk(q: string) {
    setError(null);
    setNoResults(null);
    setAnswer("");
    setSources([]);
    setMarkets([]);
    setStageDetails({});
    setCompletedStages(new Set());
    setActiveStage(null);
    setBestSim(null);
    stageStartRef.current = 0;
    setRunning(true);

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ask`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: ANON,
          Authorization: `Bearer ${ANON}`,
        },
        body: JSON.stringify({ question: q }),
      });

      if (res.status === 429) {
        setError("Daily demo limit reached — come back tomorrow.");
        setRunning(false);
        return;
      }
      if (!res.ok || !res.body) {
        setError(`Request failed (${res.status})`);
        setRunning(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const evt of events) {
          const eventLine = evt.split("\n").find((l) => l.startsWith("event:"));
          const dataLine = evt.split("\n").find((l) => l.startsWith("data:"));
          if (!eventLine || !dataLine) continue;
          const type = eventLine.slice(6).trim();
          let payload: any = {};
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch { /* ignore */ }

          if (type === "stage") {
            const id = payload.id as StageId;
            // Enforce a minimum dwell time on the previous stage so the
            // pipeline animation feels like real searching.
            if (!prefersReducedMotion() && stageStartRef.current) {
              const elapsed = Date.now() - stageStartRef.current;
              if (elapsed < MIN_STAGE_MS) await sleep(MIN_STAGE_MS - elapsed);
            }
            setActiveStage((prev) => {
              if (prev && prev !== id) completeStage(prev);
              return id;
            });
            stageStartRef.current = Date.now();
            // Seed a "searching" placeholder detail for hybrid_search
            if (id === "hybrid_search") {
              setStageDetails((d) => ({
                ...d,
                hybrid_search: d.hybrid_search ?? `Scanning ${status.count || "…"} articles…`,
              }));
            }
          } else if (type === "rewrite") {
            setStageDetails((d) => ({ ...d, rewrite: payload.query }));
          } else if (type === "coins") {
            // no-op display, coins shown via market cards
          } else if (type === "market") {
            setMarkets(payload.markets ?? []);
            const summary = (payload.markets ?? [])
              .map((m: MarketData) => `${m.symbol} $${m.price.toFixed(2)} ${m.change_24h >= 0 ? "▲" : "▼"}${Math.abs(m.change_24h).toFixed(1)}%`)
              .join(" · ");
            setStageDetails((d) => ({ ...d, market: summary }));
          } else if (type === "candidates") {
            setStageDetails((d) => ({ ...d, hybrid_search: `${payload.count} candidates` }));
          } else if (type === "rerank") {
            setStageDetails((d) => ({ ...d, rerank: `${payload.from} → ${payload.to}` }));
          } else if (type === "sources") {
            setSources(payload.sources ?? []);
          } else if (type === "no_results") {
            setNoResults(payload.message);
            setBestSim(payload.best_similarity ?? 0);
          } else if (type === "token") {
            setAnswer((a) => a + payload.text);
          } else if (type === "done") {
            if (payload.best_similarity != null) setBestSim(payload.best_similarity);
            if (!prefersReducedMotion() && stageStartRef.current) {
              const elapsed = Date.now() - stageStartRef.current;
              if (elapsed < MIN_STAGE_MS) await sleep(MIN_STAGE_MS - elapsed);
            }
            setActiveStage((prev) => {
              if (prev) completeStage(prev);
              return null;
            });
          } else if (type === "error") {
            setError(payload.message ?? "Something went wrong");
          }
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
      setActiveStage(null);
    }
  }

  function reset() {
    setQuestion("");
    setAnswer("");
    setSources([]);
    setMarkets([]);
    setError(null);
    setNoResults(null);
    setActiveStage(null);
    setCompletedStages(new Set());
    setStageDetails({});
    setBestSim(null);
  }

  const renderedAnswer = useMemo(() => {
    // split into [M] and [n] and text
    const parts = answer.split(/(\[M\]|\[\d+\])/g);
    return parts.map((p, i) => {
      if (p === "[M]") {
        return (
          <span
            key={i}
            className="inline-flex items-center gap-1 h-5 px-1.5 mx-0.5 rounded text-[10px] font-mono bg-cyan-400/15 text-cyan-300 border border-cyan-400/40 align-middle"
            title="Live market data"
          >
            <BarChart3 className="w-3 h-3" />M
          </span>
        );
      }
      const m = p.match(/^\[(\d+)\]$/);
      if (m) {
        const n = parseInt(m[1], 10);
        return (
          <button
            key={i}
            onClick={() => {
              const el = sourceRefs.current[n - 1];
              if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
            }}
            className="inline-flex items-center justify-center min-w-[22px] h-5 px-1.5 mx-0.5 rounded text-[10px] font-mono bg-primary/15 text-primary border border-primary/40 hover:bg-primary/30 transition-colors align-middle"
          >
            {n}
          </button>
        );
      }
      return <span key={i}>{p}</span>;
    });
  }, [answer]);

  const lastUpdated = status.last ? timeAgo(status.last) : "—";
  const showPipeline = running || completedStages.size > 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 sm:px-6 py-12 sm:py-16 max-w-4xl">
        <button
          onClick={() => navigate("/#projects")}
          className="inline-flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors mb-10"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="font-mono text-sm">Back to Projects</span>
        </button>

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <h1 className="text-4xl sm:text-5xl font-bold gradient-text">Crypto Research Agent</h1>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono bg-green-500/15 text-green-400 border border-green-500/40">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-400" />
            </span>
            Live Demo
          </span>
        </div>

        <p className="text-lg text-muted-foreground mb-10 leading-relaxed">
          A production RAG pipeline over real-time crypto news and live market data.
          Hybrid retrieval, reranking, and grounded citations.
        </p>

        {/* Demo section */}
        <div id="demo" ref={demoRef} className="rounded-2xl border border-primary/30 bg-card/40 p-6 sm:p-8 mb-10 scroll-mt-20">
          <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
            <div className="text-xs font-mono text-muted-foreground">
              Index: <span className="text-primary">{status.count}</span> articles · Last updated {lastUpdated}
            </div>
            <button
              onClick={() => setShowArch((s) => !s)}
              className="text-xs font-mono px-3 py-1.5 rounded-md border border-primary/40 text-primary hover:bg-primary/10 transition-colors"
            >
              {showArch ? "Hide architecture" : "View architecture"}
            </button>
          </div>

          {/* Input */}
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <input
              type="text"
              value={question}
              disabled={running}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && question.trim() && !running) runAsk(question.trim());
              }}
              placeholder="Ask anything about the crypto market..."
              className="flex-1 px-4 py-3 rounded-md bg-background/60 border border-border/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
            />
            <button
              onClick={() => question.trim() && runAsk(question.trim())}
              disabled={running || !question.trim()}
              className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:bg-primary/90 hover:shadow-[0_0_20px_hsl(var(--primary)/0.4)] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Ask
            </button>
          </div>

          {/* Chips */}
          {!answer && !running && !noResults && (
            <div className="flex flex-wrap gap-2 mb-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => {
                    setQuestion(ex);
                    runAsk(ex);
                  }}
                  className="text-xs font-mono px-3 py-1.5 rounded-full border border-primary/40 text-primary/90 hover:bg-primary/10 hover:border-primary transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          )}

          {error && (
            <div className="mt-4 px-4 py-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* Pipeline stepper */}
          {showPipeline && (
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-5 gap-2">
              {STAGES.map((s) => {
                const done = completedStages.has(s.id);
                const active = activeStage === s.id;
                const detail = s.id === "rewrite" ? rewriteTyped : stageDetails[s.id];
                return (
                  <div
                    key={s.id}
                    className={`flex flex-col gap-1 px-3 py-2 rounded-md border text-xs font-mono transition-colors ${
                      done
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : active
                        ? "border-primary/40 bg-primary/5 text-foreground"
                        : "border-border/40 bg-background/40 text-muted-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {done ? (
                        <Check className="w-3.5 h-3.5 shrink-0" />
                      ) : active ? (
                        <span className="relative flex h-2 w-2 shrink-0">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                        </span>
                      ) : (
                        <span className="w-2 h-2 rounded-full bg-muted-foreground/40 shrink-0" />
                      )}
                      <span className="truncate">{s.label}</span>
                    </div>
                    {detail && (
                      <div className="text-[10px] italic text-muted-foreground/90 truncate pl-5">
                        {detail}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Market cards */}
          {markets.length > 0 && (
            <div className={`mt-6 grid gap-3 ${markets.length > 1 ? "sm:grid-cols-2" : "grid-cols-1"}`}>
              {markets.map((m) => (
                <MarketCoinCard key={m.coingecko_id} data={m} />
              ))}
            </div>
          )}

          {/* No-results panel */}
          {noResults && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-6 p-5 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-200"
            >
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0 text-amber-400" />
                <div className="text-sm leading-relaxed">
                  <div className="font-semibold text-amber-100 mb-1">No relevant sources</div>
                  {noResults} The index covers crypto news only — try asking about a major coin or a recent market event.
                  {bestSim != null && (
                    <div className="mt-2 text-[11px] font-mono text-amber-300/80">
                      Best similarity: {(bestSim * 100).toFixed(1)}%
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}

          {/* Answer */}
          {answer && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-6 p-5 rounded-lg bg-background/40 border border-border/50"
            >
              <div className="text-[11px] font-mono uppercase tracking-wider text-primary mb-2">Answer</div>
              <div className="text-foreground/90 leading-relaxed whitespace-pre-wrap">
                {renderedAnswer}
                {running && <span className="inline-block w-1.5 h-4 ml-0.5 bg-primary/70 animate-pulse align-middle" />}
              </div>
              {!running && (sources.length > 0 || markets.length > 0) && (
                <div className="mt-3 pt-3 border-t border-border/30 text-[11px] font-mono text-muted-foreground">
                  Answer grounded in {sources.length} news source{sources.length === 1 ? "" : "s"}
                  {markets.length > 0 && " + live market data"}
                  {bestSim != null && ` · best relevance ${bestSim.toFixed(2)}`}
                </div>
              )}
            </motion.div>
          )}

          {/* Source relevance chart */}
          {sources.length > 0 && (
            <SourceRelevanceChart
              sources={sources}
              onSelect={(i) => {
                const el = sourceRefs.current[i];
                if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          )}

          {/* Sources */}
          {sources.length > 0 && (
            <div className="mt-6">
              <div className="text-[11px] font-mono uppercase tracking-wider text-primary mb-3">Sources</div>
              <div className="grid grid-cols-1 gap-3">
                {sources.map((s, i) => (
                  <div
                    key={s.url}
                    ref={(el) => (sourceRefs.current[i] = el)}
                    className="p-4 rounded-lg bg-background/40 border border-border/50 hover:border-primary/40 transition-colors scroll-mt-24"
                  >
                    <div className="flex items-start justify-between gap-3 mb-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-primary/15 text-primary border border-primary/30">
                          {i + 1}
                        </span>
                        <span className="text-xs font-mono text-muted-foreground truncate">
                          {s.source_name} · {timeAgo(s.published_at)}
                        </span>
                      </div>
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-primary shrink-0"
                        aria-label="Open source"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </div>
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-sm text-foreground/90 hover:text-primary mb-2"
                    >
                      {s.title}
                    </a>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1 rounded-full bg-border/40 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-primary/60 to-primary"
                          style={{ width: `${Math.max(0, Math.min(100, (s.similarity || 0) * 100))}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-muted-foreground w-10 text-right">
                        {((s.similarity || 0) * 100).toFixed(0)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {(answer || error || noResults) && !running && (
            <button
              onClick={reset}
              className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border/60 text-sm text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" /> New question
            </button>
          )}

          <div className="mt-6 pt-4 border-t border-border/30 text-[11px] font-mono text-muted-foreground text-center">
            Educational demo · Not financial advice · Limited to 50 queries/day
          </div>
        </div>

        {/* Embedding space explorer */}
        <div id="embedding-explorer" className="scroll-mt-20">
          <EmbeddingSpaceExplorer />
        </div>

        {/* Why this matters */}
        <WhyEmbeddingsMatter />

        {/* How it works */}
        <div className="mb-10">
          <h2 className="text-sm font-mono uppercase tracking-wider text-muted-foreground mb-4">How it works</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {HOW_IT_WORKS.map((s) => (
              <div key={s.t} className="rounded-lg border border-border/40 bg-background/40 p-4">
                <div className="text-primary font-mono text-xs mb-1">{s.t}</div>
                <AnimatePresence initial={false}>
                  {showArch && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="text-xs text-muted-foreground overflow-hidden mt-2"
                    >
                      {s.d}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ))}
          </div>
        </div>

        <div className="text-center">
          <button
            onClick={() => navigate("/#contact")}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors"
          >
            Get in touch <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default CryptoResearchAgent;
