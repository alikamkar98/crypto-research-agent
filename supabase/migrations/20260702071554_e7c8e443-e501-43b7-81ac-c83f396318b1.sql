-- Extensions
create extension if not exists vector;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- News chunks
create table if not exists public.news_chunks (
  id uuid primary key default gen_random_uuid(),
  article_title text not null,
  article_url text not null unique,
  source_name text,
  published_at timestamptz,
  chunk_text text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now()
);

grant select on public.news_chunks to anon, authenticated;
grant all on public.news_chunks to service_role;

alter table public.news_chunks enable row level security;

create policy "news_chunks readable by everyone"
  on public.news_chunks for select
  using (true);

create index if not exists news_chunks_embedding_idx
  on public.news_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists news_chunks_created_at_idx
  on public.news_chunks (created_at desc);

-- Similarity search helper
create or replace function public.match_news_chunks(
  query_embedding vector(1536),
  match_count int default 5
)
returns table (
  id uuid,
  article_title text,
  article_url text,
  source_name text,
  published_at timestamptz,
  chunk_text text,
  similarity float
)
language sql stable
set search_path = public
as $$
  select
    n.id,
    n.article_title,
    n.article_url,
    n.source_name,
    n.published_at,
    n.chunk_text,
    1 - (n.embedding <=> query_embedding) as similarity
  from public.news_chunks n
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_news_chunks(vector, int) to anon, authenticated, service_role;

-- Demo usage counter
create table if not exists public.demo_usage (
  date date primary key,
  query_count int not null default 0,
  updated_at timestamptz not null default now()
);

grant select on public.demo_usage to anon, authenticated;
grant all on public.demo_usage to service_role;

alter table public.demo_usage enable row level security;

create policy "demo_usage readable by everyone"
  on public.demo_usage for select
  using (true);
