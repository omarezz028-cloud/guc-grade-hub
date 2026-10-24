CREATE TABLE public.webhook_grade_deliveries (
 webhook_id uuid NOT NULL REFERENCES public.webhooks(id) ON DELETE CASCADE,
 course text NOT NULL,
 item text NOT NULL,
 sent_grade text,
 lease_token uuid,
 leased_until timestamptz,
 sent_at timestamptz,
 PRIMARY KEY (webhook_id, course, item)
);
GRANT ALL ON public.webhook_grade_deliveries TO service_role;
ALTER TABLE public.webhook_grade_deliveries ENABLE ROW LEVEL SECURITY;
INSERT INTO public.webhook_grade_deliveries (webhook_id,course,item,sent_grade,sent_at)
SELECT w.id,g.course,g.item,g.grade,now() FROM public.webhooks w JOIN public.grades g ON g.user_id=w.user_id;
CREATE FUNCTION public.claim_grade_notification(p_webhook_id uuid,p_course text,p_item text,p_grade text,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE claimed boolean;
BEGIN
 INSERT INTO public.webhook_grade_deliveries (webhook_id,course,item,lease_token,leased_until)
 VALUES(p_webhook_id,p_course,p_item,p_token,now()+interval '1 minute')
 ON CONFLICT (webhook_id,course,item) DO UPDATE
 SET lease_token=p_token,leased_until=now()+interval '1 minute'
 WHERE webhook_grade_deliveries.sent_grade IS DISTINCT FROM p_grade
 AND (webhook_grade_deliveries.leased_until IS NULL OR webhook_grade_deliveries.leased_until < now())
 RETURNING true INTO claimed;
 RETURN COALESCE(claimed,false);
END; $$;
REVOKE ALL ON FUNCTION public.claim_grade_notification(uuid,text,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_grade_notification(uuid,text,text,text,uuid) TO service_role;