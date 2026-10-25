import { createHmac } from "node:crypto";
import { decryptText, encryptText, randomHex } from "./crypto.server";
import { fetchGrades, GucError, type GradeRow } from "./guc.server";
import { postGradeNotification } from "@/lib/grade-notifications";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export type GradeChange = GradeRow & { previous: string | null };

async function applyGrades(userId: string, rows: GradeRow[], notify: boolean) {
  const db = await admin();
  const { data: existing, error: readError } = await db.from("grades").select("course,item,grade").eq("user_id", userId);
  if (readError) throw new Error(readError.message);
  const badHeaderRow = (existing ?? []).some(
    (g) => g.course === "General" && g.item === "Course" && g.grade === "Percentage",
  );
  if (badHeaderRow) {
    const { error } = await db
      .from("grades")
      .delete()
      .eq("user_id", userId)
      .eq("course", "General")
      .eq("item", "Course")
      .eq("grade", "Percentage");
    if (error) throw new Error(error.message);
  }
  const prev = new Map((existing ?? []).map((g) => [g.course + "|" + g.item, g.grade]));
  const changes: GradeChange[] = [];
  const upserts = [];
  for (const r of rows) {
    const old = prev.get(`${r.course}|${r.item}`) ?? null;
    if (old === r.grade) continue;
    changes.push({ ...r, previous: old });
    upserts.push({
      user_id: userId,
      course: r.course,
      item: r.item,
      grade: r.grade,
      fingerprint: r.grade,
      updated_at: new Date().toISOString(),
    });
  }
  if (upserts.length) {
    const { error } = await db.from("grades").upsert(upserts, { onConflict: "user_id,course,item" });
    if (error) throw new Error(error.message);
  }
  if (notify) {
    await sendWebhooks(userId, rows);
    await sendRitualGrades(userId, rows);
  } else {
    await baselineWebhooks(userId, rows);
  }
  return { total: rows.length, changed: changes.length };
}

const sign = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("hex");

export async function baselineWebhooks(userId: string, rows: GradeRow[], webhookId?: string) {
  const db = await admin();
  let query = db.from("webhooks").select("id").eq("user_id", userId);
  if (webhookId) query = query.eq("id", webhookId);
  const { data: hooks, error } = await query;
  if (error) throw new Error(error.message);
  const baseline = (hooks ?? []).flatMap(h => rows.map(r => ({
    webhook_id: h.id, course: r.course, item: r.item, sent_grade: r.grade,
  })));
  if (baseline.length) {
    const { error } = await db.from("webhook_grade_deliveries").upsert(baseline, {
      onConflict: "webhook_id,course,item", ignoreDuplicates: true,
    });
    if (error) throw new Error(error.message);
  }
}

function ritualGradeValue(raw: string): string | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
  return match ? match[1] + " / " + match[2] : null;
}

export async function baselineRitualGrades(userId: string) {
  const db = await admin();
  const { data: connection, error: connectionError } = await db
    .from("ritual_connections")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();
  if (connectionError) throw new Error(connectionError.message);
  if (!connection) return;

  const { data: grades, error: gradesError } = await db
    .from("grades")
    .select("course,item,grade")
    .eq("user_id", userId);
  if (gradesError) throw new Error(gradesError.message);
  const now = new Date().toISOString();
  const baseline = (grades ?? []).flatMap((row) => {
    const grade = ritualGradeValue(row.grade);
    return grade
      ? [{ connection_id: connection.id, course: row.course, item: row.item, sent_grade: grade, sent_at: now }]
      : [];
  });
  if (baseline.length) {
    const { error } = await db.from("ritual_grade_deliveries").upsert(baseline, {
      onConflict: "connection_id,course,item",
    });
    if (error) throw new Error(error.message);
  }
}

export async function sendRitualGrades(userId: string, rows: GradeRow[]) {
  const db = await admin();
  const { data: connection, error: connectionError } = await db
    .from("ritual_connections")
    .select("id,secret_cipher,enabled")
    .eq("user_id", userId)
    .maybeSingle();
  if (connectionError) throw new Error(connectionError.message);
  if (!connection?.enabled || !connection.secret_cipher) return;

  const secret = await decryptText(connection.secret_cipher);
  for (const row of rows) {
    const grade = ritualGradeValue(row.grade);
    if (!grade) continue;
    const leaseToken = crypto.randomUUID();
    const { data: claimed, error: claimError } = await db.rpc("claim_ritual_grade", {
      p_connection_id: connection.id,
      p_course: row.course,
      p_item: row.item,
      p_grade: grade,
      p_token: leaseToken,
    });
    if (claimError) throw new Error(claimError.message);
    if (!claimed) continue;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch("https://habit-buddy-app-47.lovable.app/api/public/grades", {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + secret,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ course: row.course, item: row.item, grade }),
      });
    } catch {
      await db
        .from("ritual_grade_deliveries")
        .update({ lease_token: null, leased_until: null })
        .eq("connection_id", connection.id)
        .eq("course", row.course)
        .eq("item", row.item)
        .eq("lease_token", leaseToken);
      await db.from("ritual_connections").update({ last_status: "Delivery failed; it will retry." }).eq("id", connection.id);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401) {
      await db
        .from("ritual_connections")
        .update({
          secret_cipher: null,
          enabled: false,
          last_status: "Ritual disconnected. Reconnect from Ritual to resume grade delivery.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", connection.id);
      break;
    }
    if (response.status !== 200) {
      await db
        .from("ritual_grade_deliveries")
        .update({ lease_token: null, leased_until: null })
        .eq("connection_id", connection.id)
        .eq("course", row.course)
        .eq("item", row.item)
        .eq("lease_token", leaseToken);
      await db.from("ritual_connections").update({ last_status: "Ritual returned HTTP " + response.status + "; it will retry." }).eq("id", connection.id);
      continue;
    }

    const now = new Date().toISOString();
    const { error: deliveryError } = await db
      .from("ritual_grade_deliveries")
      .update({ sent_grade: grade, sent_at: now, lease_token: null, leased_until: null })
      .eq("connection_id", connection.id)
      .eq("course", row.course)
      .eq("item", row.item)
      .eq("lease_token", leaseToken);
    if (deliveryError) throw new Error(deliveryError.message);
    await db
      .from("ritual_connections")
      .update({ last_status: "Grade sent successfully.", last_sent_at: now })
      .eq("id", connection.id);
  }
}

export async function sendWebhooks(userId: string, rows: GradeRow[], testWebhookId?: string) {
  const db = await admin();
  let query = db.from("webhooks").select("id,url,signing_secret").eq("user_id", userId);
  if (testWebhookId) query = query.eq("id", testWebhookId);
  const { data: hooks, error } = await query;
  if (error) throw new Error(error.message);
  if (testWebhookId && !hooks?.length) throw new Error("Notification address not found");
  const results = [];
  for (const hook of hooks ?? []) {
    for (const row of rows) {
      const token = crypto.randomUUID();
      if (!testWebhookId) {
        const { data: claimed, error } = await db.rpc("claim_grade_notification", {
          p_webhook_id: hook.id, p_course: row.course, p_item: row.item,
          p_grade: row.grade, p_token: token,
        });
        if (error) throw new Error(error.message);
        if (!claimed) continue;
      }
      const result = await postGradeNotification(hook.url, row, process.env['RITUAL_SECRET']?.trim(), hook.signing_secret, sign);
      const now = new Date().toISOString();
      if (!testWebhookId) {
        const { error } = await db.from("webhook_grade_deliveries").update({
          lease_token: null, leased_until: null,
          ...(result.ok ? { sent_grade: row.grade, sent_at: now } : {}),
        }).eq("webhook_id", hook.id).eq("course", row.course).eq("item", row.item).eq("lease_token", token);
        if (error) throw new Error(error.message);
      }
      const { error } = await db.from("webhooks").update({ last_status: result.status, last_called_at: now }).eq("id", hook.id);
      if (error) throw new Error(error.message);
      results.push({ id: hook.id, ...result });
    }
  }
  return results;
}

/** Links the account and returns the just-fetched rows for the first Ritual delivery. */
export async function linkAndSyncWithRows(userId: string, username: string, password: string) {
  const rows = await fetchGrades(username, password); // throws GucError on bad login
  const db = await admin();
  const { error } = await db.from("guc_accounts").upsert({
    user_id: userId,
    guc_username: username,
    password_cipher: await encryptText(password),
    last_synced_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  const result = await applyGrades(userId, rows, false);
  return { ...result, rows };
}

/** Existing callers keep receiving only the summary; grade rows stay server-side. */
export async function linkAndSync(userId: string, username: string, password: string) {
  const { rows: _rows, ...result } = await linkAndSyncWithRows(userId, username, password);
  return result;
}

export async function syncAccount(userId: string) {
  const db = await admin();
  const { data: acc } = await db.from("guc_accounts").select("*").eq("user_id", userId).maybeSingle();
  if (!acc) throw new GucError("No GUC account linked yet.", "unexpected");
  try {
    const rows = await fetchGrades(acc.guc_username, await decryptText(acc.password_cipher));
    const result = await applyGrades(userId, rows, acc.last_synced_at !== null);
    await db
      .from("guc_accounts")
      .update({ last_synced_at: new Date().toISOString(), last_error: null })
      .eq("user_id", userId);
    return result;
  } catch (e) {
    await db
      .from("guc_accounts")
      .update({ last_error: e instanceof Error ? e.message.slice(0, 200) : "Sync failed" })
      .eq("user_id", userId);
    throw e;
  }
}

export async function syncAll() {
  const db = await admin();
  const { data } = await db.from("guc_accounts").select("user_id");
  const ids = (data ?? []).map((a) => a.user_id);
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += 5) {
    const res = await Promise.allSettled(ids.slice(i, i + 5).map(syncAccount));
    res.forEach((r) => (r.status === "fulfilled" ? ok++ : failed++));
  }
  return { ok, failed };
}

export { randomHex };
