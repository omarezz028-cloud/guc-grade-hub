import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { encryptText, randomHex } from "@/server/crypto.server";
import { linkAndSyncWithRows, sendRitualGrades } from "@/server/sync.server";

const RITUAL_RETURN_ORIGIN = "https://habit-buddy-app-47.lovable.app";
const RITUAL_CONNECT_ENDPOINT = RITUAL_RETURN_ORIGIN + "/api/public/grades";

async function responseError(response: Response, secret: string, state: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") {
      return body.error.slice(0, 240).split(secret).join("[redacted]").split(state).join("[redacted]");
    }
  } catch {
    /* Keep the generic status when Ritual returned no JSON error. */
  }
  return "Ritual could not finish the connection.";
}

/** Completes the GUC sign-in and exchanges a one-time Ritual state for a server-only grade secret. */
export const connectToRitual = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({
      username: z.string().trim().min(2).max(120),
      password: z.string().min(1).max(200),
      state: z.string().length(64),
      returnUrl: z.string().url().max(2048),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    if (!/^[a-f0-9]{64}$/i.test(data.state)) {
      return { ok: false as const, error: "This Ritual connection link is invalid. Start again in Ritual." };
    }

    let returnUrl: URL;
    try {
      returnUrl = new URL(data.returnUrl);
    } catch {
      return { ok: false as const, error: "The return address is invalid." };
    }
    if (!data.returnUrl.startsWith(RITUAL_RETURN_ORIGIN + "/") || returnUrl.origin !== RITUAL_RETURN_ORIGIN) {
      return { ok: false as const, error: "This return address is not allowed. Start again from Ritual." };
    }

    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { data: existingAccount, error: accountError } = await db
      .from("guc_accounts")
      .select("user_id")
      .eq("guc_username", data.username)
      .limit(1)
      .maybeSingle();
    if (accountError) {
      return { ok: false as const, error: "Could not prepare the GUC account. Please try again." };
    }

    const userId = existingAccount?.user_id ?? crypto.randomUUID();
    let initialRows: { course: string; item: string; grade: string }[];
    try {
      // Use the successful login fetch for Ritual's first delivery; don't open a second GUC session.
      const linked = await linkAndSyncWithRows(userId, data.username, data.password);
      initialRows = linked.rows;
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "Could not sign in to GUC.",
      };
    }

    const { data: previousConnection, error: readConnectionError } = await db
      .from("ritual_connections")
      .select("id,user_id,secret_cipher,enabled,connected_at,last_status,last_sent_at,updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (readConnectionError) {
      const code = readConnectionError.code || "unknown";
      return { ok: false as const, error: "Could not read Ritual connection storage (database code: " + code + ")." };
    }
    const restoreConnection = async () => {
      if (previousConnection) {
        await db.from("ritual_connections").update(previousConnection).eq("user_id", userId);
      } else {
        await db.from("ritual_connections").delete().eq("user_id", userId);
      }
    };
    const secret = randomHex(32);
    const now = new Date().toISOString();
    const connectionValues = {
      id: previousConnection?.id ?? crypto.randomUUID(),
      user_id: userId,
      secret_cipher: await encryptText(secret),
      enabled: true,
      connected_at: now,
      last_status: "Connecting to Ritual.",
      last_sent_at: previousConnection?.last_sent_at ?? null,
      updated_at: now,
    };
    const { error: saveError } = previousConnection
      ? await db.from("ritual_connections").update(connectionValues).eq("user_id", userId)
      : await db.from("ritual_connections").insert(connectionValues);
    if (saveError) {
      const code = saveError.code || "unknown";
      const schemaUnavailable = ["PGRST205", "PGRST204", "42P01", "42703"].includes(code);
      return {
        ok: false as const,
        error: schemaUnavailable
          ? "GUC's Ritual connection storage is not ready (database code: " + code + "). Wait for the latest migration, then start a new connection from Ritual."
          : "Could not securely prepare the Ritual connection (database code: " + code + "). Please share this code with support.",
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch(RITUAL_CONNECT_ENDPOINT, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connect: true, state: data.state, secret }),
      });
    } catch (error) {
      await restoreConnection();
      const cause = error && typeof error === "object" && "cause" in error
        ? (error as { cause?: { code?: unknown; message?: unknown } }).cause
        : undefined;
      const causeCode = cause && typeof cause.code === "string" ? cause.code : "";
      const causeMessage = cause && typeof cause.message === "string" ? cause.message : "";
      const rawMessage = error instanceof Error ? error.message : "";
      const detail = controller.signal.aborted
        ? "timeout"
        : [causeCode, causeMessage || rawMessage]
            .filter(Boolean)
            .join(": ")
            .replace(/https?:\/\/[^\s]+/gi, "[endpoint]")
            .split(secret).join("[redacted]")
            .split(data.state).join("[redacted]")
            .slice(0, 120) || "unknown network error";
      return {
        ok: false as const,
        error: "Could not reach Ritual (HTTPS: " + detail + "). Check the Ritual app deployment and try again.",
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      let target: URL | null = null;
      try {
        target = location ? new URL(location, RITUAL_CONNECT_ENDPOINT) : null;
      } catch {
        target = null;
      }
      const original = new URL(RITUAL_CONNECT_ENDPOINT);
      const safeRedirect =
        target?.origin === original.origin &&
        target.pathname === original.pathname &&
        target.search === "" &&
        target.hash === "";
      if (!safeRedirect || (response.status !== 307 && response.status !== 308)) {
        await restoreConnection();
        return {
          ok: false as const,
          error: "Ritual redirected the connection (HTTP " + response.status + "). Its grades endpoint must accept a direct POST.",
        };
      }
      const redirectedController = new AbortController();
      const redirectedTimer = setTimeout(() => redirectedController.abort(), 30_000);
      try {
        response = await fetch(target.toString(), {
          method: "POST",
          redirect: "error",
          signal: redirectedController.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connect: true, state: data.state, secret }),
        });
      } catch {
        await restoreConnection();
        return { ok: false as const, error: "Ritual's redirected HTTPS request failed." };
      } finally {
        clearTimeout(redirectedTimer);
      }
    }

    if (response.status !== 200) {
      const detail = await responseError(response, secret, data.state);
      await restoreConnection();
      return {
        ok: false as const,
        error: "Ritual returned HTTP " + response.status + ": " + detail,
      };
    }

    try {
      const { error: clearDeliveryError } = await db
        .from("ritual_grade_deliveries")
        .delete()
        .eq("connection_id", connectionValues.id);
      if (clearDeliveryError) throw new Error("Could not prepare the initial grade delivery.");
      await sendRitualGrades(userId, initialRows);
    } catch {
      // The handshake succeeded; scheduled sync will retry this delivery if it failed.
      await db.from("ritual_connections").update({
        last_status: "Initial grade delivery failed; it will retry on the next sync.",
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId);
    }
    return { ok: true as const, returnUrl: data.returnUrl };
  });
