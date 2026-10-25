import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

const lastManualSync = new Map<string, number>();

export const Route = createFileRoute("/api/public/sync-now")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const bearer = request.headers.get("authorization")?.match(/^Bearer\s+([a-f0-9]{64})$/i)?.[1];
        if (!bearer) {
          return Response.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { decryptText, sha256Hex } = await import("@/server/crypto.server");
        const { data: connections, error } = await supabaseAdmin
          .from("ritual_connections")
          .select("user_id,secret_cipher,enabled")
          .eq("enabled", true);
        if (error) {
          return Response.json({ error: "Could not check the GUC connection." }, { status: 500, headers: { "Cache-Control": "no-store" } });
        }

        const supplied = Buffer.from(bearer.toLowerCase(), "hex");
        let userId: string | null = null;
        for (const connection of connections ?? []) {
          if (!connection.secret_cipher) continue;
          try {
            const expected = Buffer.from(await sha256Hex(await decryptText(connection.secret_cipher)), "hex");
            if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) {
              userId = connection.user_id;
              break;
            }
          } catch {
            // Skip invalid encrypted records without exposing details or secrets.
          }
        }
        if (!userId) {
          return Response.json({ error: "Unauthorized." }, { status: 401, headers: { "Cache-Control": "no-store" } });
        }

        const now = Date.now();
        const previous = lastManualSync.get(userId) ?? 0;
        if (now - previous < 15_000) {
          return Response.json({ error: "Please wait a few seconds before checking again." }, { status: 429, headers: { "Cache-Control": "no-store" } });
        }
        lastManualSync.set(userId, now);

        try {
          const { syncAccount } = await import("@/server/sync.server");
          const result = await syncAccount(userId);
          return Response.json(
            { ok: true, total: result.total, changed: result.changed },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch {
          return Response.json(
            { error: "GUC could not complete the grade check. Verify the saved GUC sign-in and try again." },
            { status: 502, headers: { "Cache-Control": "no-store" } },
          );
        }
      },
    },
  },
});
