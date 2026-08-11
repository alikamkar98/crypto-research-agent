import { motion } from "framer-motion";

type Row = { label: string; value: number; idx: number };

export default function SourceRelevanceChart({
  sources,
  onSelect,
}: {
  sources: { source_name: string; similarity: number }[];
  onSelect: (i: number) => void;
}) {
  const rows: Row[] = sources.map((s, i) => ({
    label: `${i + 1}. ${s.source_name}`,
    value: Math.max(0, Math.min(1, s.similarity || 0)),
    idx: i,
  }));
  if (rows.length === 0) return null;

  return (
    <div className="mt-6 p-4 rounded-lg bg-background/40 border border-border/50">
      <div className="text-[11px] font-mono uppercase tracking-wider text-primary mb-3">
        Source relevance
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <button
            key={r.idx}
            onClick={() => onSelect(r.idx)}
            className="w-full text-left group"
          >
            <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground group-hover:text-foreground transition-colors">
              <span className="w-32 sm:w-40 truncate">{r.label}</span>
              <div className="flex-1 h-2 rounded-full bg-border/40 overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: `${r.value * 100}%` }}
                  transition={{ duration: 0.7, delay: r.idx * 0.08, ease: "easeOut" }}
                  className="h-full bg-gradient-to-r from-primary/50 to-primary"
                />
              </div>
              <span className="w-10 text-right tabular-nums">
                {(r.value * 100).toFixed(0)}%
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
