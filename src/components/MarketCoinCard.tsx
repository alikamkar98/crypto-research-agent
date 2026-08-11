import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { motion } from "framer-motion";

export type MarketData = {
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

function fmtPrice(n: number) {
  if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}
function fmtCompact(n: number) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(0)}`;
}

export default function MarketCoinCard({ data }: { data: MarketData }) {
  const up = data.change_24h >= 0;
  const chartData = data.series.map((pt) => ({ t: pt.t, p: pt.p }));
  const gradId = `grad-${data.coingecko_id}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="rounded-xl border border-primary/30 bg-card/40 p-4 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {data.image ? (
            <img src={data.image} alt={data.name} className="w-7 h-7 rounded-full" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-primary/20" />
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{data.name}</div>
            <div className="text-[10px] font-mono text-muted-foreground">{data.symbol}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-base font-mono font-semibold tabular-nums">{fmtPrice(data.price)}</div>
          <div
            className={`inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-mono ${
              up
                ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/40"
                : "bg-red-500/15 text-red-400 border border-red-500/40"
            }`}
          >
            {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
            {data.change_24h.toFixed(2)}%
          </div>
        </div>
      </div>

      <div className="h-32 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="t" hide />
            <YAxis domain={["dataMin", "dataMax"]} hide />
            <Tooltip
              cursor={{ stroke: "hsl(var(--primary))", strokeOpacity: 0.4 }}
              contentStyle={{
                background: "hsl(var(--background))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                fontSize: 11,
                fontFamily: "monospace",
              }}
              labelFormatter={(v) => new Date(v as number).toLocaleString()}
              formatter={(v: any) => [fmtPrice(v as number), "Price"]}
            />
            <Area
              type="monotone"
              dataKey="p"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              fill={`url(#${gradId})`}
              isAnimationActive
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3 text-[10px] font-mono">
        <div>
          <div className="text-muted-foreground">7d</div>
          <div className={data.change_7d >= 0 ? "text-emerald-400" : "text-red-400"}>
            {data.change_7d.toFixed(2)}%
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">Vol 24h</div>
          <div className="text-foreground/90">{fmtCompact(data.volume_24h)}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Mkt Cap</div>
          <div className="text-foreground/90">{fmtCompact(data.market_cap)}</div>
        </div>
      </div>
    </motion.div>
  );
}
