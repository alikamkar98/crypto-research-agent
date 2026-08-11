CREATE OR REPLACE FUNCTION public.news_index_status()
RETURNS TABLE(total bigint, latest timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::bigint, max(created_at) FROM public.news_chunks;
$$;

REVOKE ALL ON FUNCTION public.news_index_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.news_index_status() TO anon, authenticated;