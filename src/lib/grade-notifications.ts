export type NotificationGrade = { course: string; item: string; grade: string };

export function formatGrade(grade: string) {
  return grade.trim().replace(/\s*\/\s*/g, " / ");
}

export function gradePayload(row: NotificationGrade): NotificationGrade {
  return { course: row.course, item: row.item, grade: formatGrade(row.grade) };
}

export function isPublicNotificationUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.port === "" || url.port === "443") && host.includes(".") &&
      !/^[\d.]+$/.test(host) && !host.includes(":") &&
      !/(^|\.)(localhost|local|internal|test|invalid)$/.test(host);
  } catch { return false; }
}

export async function postGradeNotification(
  url: string,
  row: NotificationGrade,
  secret: string | undefined,
  signingSecret: string,
  sign: (body: string, secret: string) => string,
  request: typeof fetch = fetch,
) {
  if (!secret) return { ok: false, status: "Ritual secret is not configured" };
  if (!isPublicNotificationUrl(url)) return { ok: false, status: "Use a public HTTPS address" };
  const body = JSON.stringify(gradePayload(row));
  try {
    const response = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${secret}`,
        "x-guc-signature": `sha256=${sign(body, signingSecret)}`,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel();
    return { ok: response.ok, status: `HTTP ${response.status}` };
  } catch {
    return { ok: false, status: "No HTTP response (connection failed or timed out)" };
  }
}