
-- 1. Revoke EXECUTE on SECURITY DEFINER functions from anon/authenticated.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_consents_updated_at() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_conversations_user_id() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.set_messages_user_id_from_conversation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.limit_4_user_questions() FROM PUBLIC;

-- 2. Contact messages: drop permissive INSERT policies (edge function uses service role).
DROP POLICY IF EXISTS "Allow public inserts" ON public.contact_messages;
DROP POLICY IF EXISTS "contact_messages_insert_authenticated" ON public.contact_messages;

-- 3. Storage: replace explainability read policy so it can't be used to LIST the bucket.
DROP POLICY IF EXISTS "explainability_public_read" ON storage.objects;
CREATE POLICY "explainability_public_read_objects"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'explainability' AND name IS NOT NULL AND name <> '');

-- 4. Hide internal backend tables from public GraphQL introspection.
REVOKE SELECT ON public.coin_registry FROM anon, authenticated;
REVOKE SELECT ON public.demo_usage FROM anon, authenticated;
REVOKE SELECT ON public.news_chunks FROM anon, authenticated;
REVOKE SELECT ON public.market_cache FROM anon, authenticated;
GRANT ALL ON public.coin_registry, public.demo_usage, public.news_chunks, public.market_cache TO service_role;
