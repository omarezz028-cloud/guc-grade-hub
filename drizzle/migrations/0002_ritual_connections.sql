CREATE TABLE public.ritual_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  secret_cipher text,
  enabled boolean NOT NULL DEFAULT true,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_status text,
  last_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.ritual_connections ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.ritual_connections TO service_role;

CREATE TABLE public.ritual_grade_deliveries (
  connection_id uuid NOT NULL REFERENCES public.ritual_connections(id) ON DELETE CASCADE,
  course text NOT NULL,
  item text NOT NULL,
  sent_grade text,
  lease_token uuid,
  leased_until timestamptz,
  sent_at timestamptz,
  PRIMARY KEY (connection_id, course, item)
);
ALTER TABLE public.ritual_grade_deliveries ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.ritual_grade_deliveries TO service_role;

CREATE FUNCTION public.claim_ritual_grade(
  p_connection_id uuid,
  p_course text,
  p_item text,
  p_grade text,
  p_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed boolean;
BEGIN
  INSERT INTO public.ritual_grade_deliveries (connection_id, course, item, lease_token, leased_until)
  VALUES (p_connection_id, p_course, p_item, p_token, now() + interval '1 minute')
  ON CONFLICT (connection_id, course, item) DO UPDATE
  SET lease_token = p_token, leased_until = now() + interval '1 minute'
  WHERE ritual_grade_deliveries.sent_grade IS DISTINCT FROM p_grade
    AND (ritual_grade_deliveries.leased_until IS NULL OR ritual_grade_deliveries.leased_until < now())
  RETURNING true INTO claimed;
  RETURN COALESCE(claimed, false);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ritual_grade(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ritual_grade(uuid, text, text, text, uuid) TO service_role;
