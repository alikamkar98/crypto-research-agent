
-- Restrict demo_usage to admins only
DROP POLICY IF EXISTS "demo_usage readable by everyone" ON public.demo_usage;
CREATE POLICY "Admins can view demo_usage"
  ON public.demo_usage FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Switch has_role to SECURITY INVOKER (kills SECURITY DEFINER linter findings).
-- Callers are authenticated users; user_roles RLS lets them see own rows,
-- which is all has_role checks.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY INVOKER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$function$;

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

-- Reduce GraphQL/PostgREST discoverability of internal & sensitive tables.
-- These tables are only accessed server-side via the service role, or are
-- restricted to specific authenticated users through RLS.
REVOKE SELECT ON public.news_chunks   FROM anon, authenticated;
REVOKE SELECT ON public.market_cache  FROM anon, authenticated;
REVOKE SELECT ON public.demo_usage    FROM anon;
REVOKE SELECT ON public.contact_messages FROM anon;
REVOKE SELECT ON public.consents      FROM anon;
REVOKE SELECT ON public.conversations FROM anon;
REVOKE SELECT ON public.messages      FROM anon;
REVOKE SELECT ON public.user_roles    FROM anon;
REVOKE SELECT ON public.coin_registry FROM anon;

-- Defensive: ensure anon cannot even attempt to read consents rows
-- (no SELECT policy existed, but revoking the grant makes it explicit).
