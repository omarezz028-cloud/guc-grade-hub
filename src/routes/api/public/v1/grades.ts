import { createFileRoute } from "@tanstack/react-router";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-api-key, apikey",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export const Route = createFileRoute("/api/public/v1/grades")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: cors }),
      GET: async ({ request }) => {
        const authorization = (request.headers.get("authorization") ?? "").trim();
        const candidates = [
          authorization,
          request.headers.get("x-api-key") ?? "",
          request.headers.get("apikey") ?? "",
        ].map((candidate) =>
          candidate
            .trim()
            .replace(/^(?:Bearer\s*:?\s*)+/i, "")
            .replace(/^["']|["']$/g, "")
            .trim(),
        );
        const apiKey = candidates.find((candidate) => /^guc_[a-f0-9]{48}$/i.test(candidate));
        if (!apiKey) {
          return Response.json(
            { error: "Missing or malformed API key. Send the full key as Authorization: Bearer <key> or x-api-key." },
            { status: 401, headers: cors },
          );
        }
        const { sha256Hex } = await import("@/server/crypto.server");
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: key } = await supabaseAdmin
          .from("api_keys")
          .select("id,user_id")
          .eq("key_hash", await sha256Hex(apiKey.toLowerCase()))
          .maybeSingle();
        if (!key) return Response.json({ error: "API key not recognized. Copy the full key from Grade Hub and try again." }, { status: 401, headers: cors });
        await supabaseAdmin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id);
        const [{ data: grades }, { data: acc }] = await Promise.all([
          supabaseAdmin
            .from("grades")
            .select("course,item,grade,updated_at")
            .eq("user_id", key.user_id)
            .order("course"),
          supabaseAdmin.from("guc_accounts").select("last_synced_at").eq("user_id", key.user_id).maybeSingle(),
        ]);
        return Response.json(
          { last_synced_at: acc?.last_synced_at ?? null, grades: grades ?? [] },
          { headers: cors },
        );
      },
    },
  },
});
