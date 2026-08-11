
-- Cache of 2D projections for the embedding-map explorer
CREATE TABLE IF NOT EXISTS public.embedding_map_cache (
  chunk_id uuid PRIMARY KEY REFERENCES public.news_chunks(id) ON DELETE CASCADE,
  x double precision NOT NULL,
  y double precision NOT NULL,
  title text NOT NULL,
  source text NOT NULL,
  published_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.embedding_map_cache TO anon, authenticated;
GRANT ALL ON public.embedding_map_cache TO service_role;

ALTER TABLE public.embedding_map_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "embedding_map_cache public read"
  ON public.embedding_map_cache
  FOR SELECT
  USING (true);

-- Stored PCA model (mean + two principal components in the original 1536-dim space)
CREATE TABLE IF NOT EXISTS public.pca_model (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mean jsonb NOT NULL,
  pc1 jsonb NOT NULL,
  pc2 jsonb NOT NULL,
  dims int NOT NULL,
  n_samples int NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.pca_model TO anon, authenticated;
GRANT ALL ON public.pca_model TO service_role;

ALTER TABLE public.pca_model ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pca_model public read"
  ON public.pca_model
  FOR SELECT
  USING (true);

-- Separate lightweight rate limit for embedding-query action
ALTER TABLE public.demo_usage
  ADD COLUMN IF NOT EXISTS embed_count int NOT NULL DEFAULT 0;
