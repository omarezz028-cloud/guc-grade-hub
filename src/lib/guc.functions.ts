import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isPublicNotificationUrl } from "./grade-notifications";

export const getDashboard = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const sb = context.supabase;
    const [acc, grades, keys, hooks] = await Promise.all([
      sb.from("guc_accounts").select("guc_username,last_synced_at,last_error").maybeSingle(),
      sb.from("grades").select("id,course,item,grade,updated_at").order("course").order("item"),
      sb.from("api_keys").select("id,name,key_prefix,last_used_at,created_at").order("created_at"),
      sb.from("webhooks").select("id,url,last_status,last_called_at").order("created_at"),
    ]);
    return {
      account: acc.data,
      grades: grades.data ?? [],
      keys: keys.data ?? [],
      webhooks: hooks.data ?? [],
    };
  });

export const linkGucAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ username: z.string().trim().min(2).max(120), password: z.string().min(1).max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { linkAndSync } = await import("@/server/sync.server");
    try {
      return { ok: true as const, ...(await linkAndSync(context.userId, data.username, data.password)) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Could not sign in to GUC" };
    }
  });

export const syncNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { syncAccount } = await import("@/server/sync.server");
    try {
      return { ok: true as const, ...(await syncAccount(context.userId)) };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "Sync failed" };
    }
  });

export const unlinkGucAccount = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await context.supabase.from("guc_accounts").delete().eq("user_id", context.userId);
    return { ok: true };
  });

export const createApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ name: z.string().trim().min(1).max(60) }).parse(d))
  .handler(async ({ data, context }) => {
    const { randomHex, sha256Hex } = await import("@/server/crypto.server");
    const key = `guc_${randomHex(24)}`;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("api_keys").insert({
      user_id: context.userId,
      name: data.name,
      key_prefix: key.slice(0, 10),
      key_hash: await sha256Hex(key),
    });
    if (error) throw new Error(error.message);
    return { key };
  });

export const deleteApiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await context.supabase.from("api_keys").delete().eq("id", data.id);
    return { ok: true };
  });

export const addWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ url: z.string().url().max(500).refine(isPublicNotificationUrl, "Use a public HTTPS address") }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { randomHex } = await import("@/server/crypto.server");
    const secret = `whsec_${randomHex(24)}`;
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: hook, error } = await supabaseAdmin
      .from("webhooks")
      .insert({ user_id: context.userId, url: data.url, signing_secret: secret }).select("id").single();
    if (error) throw new Error(error.message);
    const { data: grades, error: gradeError } = await context.supabase.from("grades").select("course,item,grade");
    if (gradeError) throw new Error(gradeError.message);
    if (hook) {
      const { baselineWebhooks } = await import("@/server/sync.server");
      await baselineWebhooks(context.userId, grades ?? [], hook.id);
    }
    return { ok: true };
  });

export const deleteWebhook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await context.supabase.from("webhooks").delete().eq("id", data.id);
    return { ok: true };
  });

export const testWebhooks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { sendWebhooks } = await import("@/server/sync.server");
    return sendWebhooks(context.userId, [
      { course: "TEST 101", item: "Test notification", grade: "10 / 10" },
    ], data.id);
  });
