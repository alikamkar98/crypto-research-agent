-- 1. news_chunks: remove public read policy + grants (server-only via service role)
DROP POLICY IF EXISTS "news_chunks readable by everyone" ON public.news_chunks;
REVOKE ALL ON public.news_chunks FROM anon, authenticated;
GRANT ALL ON public.news_chunks TO service_role;

-- 2. pca_model: remove public read policy + grants (server-only via service role)
DROP POLICY IF EXISTS "pca_model public read" ON public.pca_model;
REVOKE ALL ON public.pca_model FROM anon, authenticated;
GRANT ALL ON public.pca_model TO service_role;

-- 3. contact_messages: ensure no client-side insert path exists; only the
--    contact-submit edge function (service role) may write.
DROP POLICY IF EXISTS "Allow public inserts" ON public.contact_messages;
DROP POLICY IF EXISTS "contact_messages_insert_authenticated" ON public.contact_messages;
REVOKE INSERT, UPDATE, DELETE ON public.contact_messages FROM anon, authenticated;
REVOKE ALL ON public.contact_messages FROM anon;
GRANT SELECT ON public.contact_messages TO authenticated; -- admin-only via RLS has_role()
GRANT ALL ON public.contact_messages TO service_role;