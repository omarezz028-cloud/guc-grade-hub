import { createHmac } from "node:crypto";
import { decryptText, encryptText, randomHex } from "./crypto.server";
import { fetchGrades, GucError, type GradeRow } from "./guc.server";

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

export type GradeChange = GradeRow & { previous: string | null };

async function applyGrades(userId: string, rows: GradeRow[], notify: boolean) {
  const db = await admin();
  const { data: existing } = await db.from("grades").select("course,item,grade").eq("user_id", userId);
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
  if (notify && changes.length) await sendWebhooks(userId, changes);
  return { total: rows.length, changed: changes.length };
}

export async function sendWebhooks(userId: string, changes: GradeChange[]) {
  const db = await admin();
  const { data: hooks } = await db.from("webhooks").select("*").eq("user_id", userId);
  const body = JSON.stringify({
    event: "grades.updated",
    sent_at: new Date().toISOString(),
    changes: changes.map((c) => ({
      course: c.course,
      item: c.item,
      grade: c.grade,
      previous_grade: c.previous,
    })),
  });
  await Promise.allSettled(
    (hooks ?? []).map(async (h) => {
      let status: string;
      try {
        const sig = createHmac("sha256", h.signing_secret).update(body).digest("hex");
        const res = await fetch(h.url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-guc-signature": `sha256=${sig}` },
          body,
          signal: AbortSignal.timeout(8000),
        });
        status = String(res.status);
      } catch (e) {
        status = e instanceof Error ? e.message.slice(0, 80) : "failed";
      }
      await db
        .from("webhooks")
        .update({ last_status: status, last_called_at: new Date().toISOString() })
        .eq("id", h.id);
    }),
  );
}

export async function linkAndSync(userId: string, username: string, password: string) {
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
  return applyGrades(userId, rows, false);
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
