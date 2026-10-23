import { ntlmType1, ntlmType3 } from "./ntlm.server";
import { KeepAliveConnection } from "./http1.server";

const BASE = "https://apps.guc.edu.eg";
// Pages that list grades. Add more paths here to collect more grade types.
const GRADE_PATHS = ["/student_ext/Grade/CheckGrade_01.aspx"];

export class GucError extends Error {
  constructor(
    message: string,
    public code: "bad_credentials" | "unreachable" | "unexpected",
  ) {
    super(message);
  }
}

export type GradeRow = { course: string; item: string; grade: string };

function splitUser(raw: string): { user: string; domain: string } {
  let t = raw.trim();
  if (t.includes("@")) t = t.slice(0, t.indexOf("@"));
  const i = t.indexOf("\\");
  return i > -1 ? { domain: t.slice(0, i), user: t.slice(i + 1) } : { domain: "", user: t };
}

async function ntlmGet(path: string, rawUser: string, password: string): Promise<string> {
  const { user, domain } = splitUser(rawUser);
  const conn = new KeepAliveConnection(new URL(BASE).host);
  try {
    let r1;
    try {
      r1 = await conn.request("GET", path, { Authorization: `NTLM ${ntlmType1()}` });
    } catch {
      throw new GucError("Could not reach the GUC portal.", "unreachable");
    }
    const auth = (r1.headers["www-authenticate"] ?? []).join(", ");
    const challenge = /NTLM\s+([A-Za-z0-9+/=]{20,})/.exec(auth);
    if (!challenge) {
      throw new GucError(
        `GUC portal did not start a login handshake (status ${r1.status}).`,
        "unexpected",
      );
    }
    const r2 = await conn.request("GET", path, {
      Authorization: `NTLM ${ntlmType3(challenge[1]!, user, password, domain)}`,
    });
    if (r2.status === 401) {
      throw new GucError("GUC rejected the username or password.", "bad_credentials");
    }
    if (r2.status < 200 || r2.status >= 300) {
      throw new GucError(`GUC portal returned status ${r2.status}.`, "unexpected");
    }
    return r2.body;
  } finally {
    conn.close();
  }
}

const decode = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** Parse grade tables, using their column headers when the portal provides them. */
export function parseGrades(html: string): GradeRow[] {
  const tables = [...html.matchAll(/<table\\b((?:(?!<table\\b)[\\s\\S])*?)<\\/table>/gi)].map((m) => m[1] ?? "");
  const preferred = tables.filter((t) => /id="[^"]*(midDg|grade|Dg)[^"]*"/i.test(t.split(">")[0] ?? ""));
  const chosen = preferred.length ? preferred : tables;
  const rows: GradeRow[] = [];
  const seen = new Map<string, number>();
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
  const courseLabels = new Set(["course", "course code", "course name", "subject", "subject code"]);
  const itemLabels = new Set(["item", "assessment", "component", "exam", "exam type", "grade item"]);
  const gradeLabels = new Set(["grade", "percentage", "percent", "mark", "marks", "score", "result", "obtained"]);
  const knownLabels = new Set([...courseLabels, ...itemLabels, ...gradeLabels, "date", "type"]);

  for (const table of chosen) {
    const parsed = [...table.matchAll(/<tr\\b[\\s\\S]*?<\\/tr>/gi)].map((match) => ({
      html: match[0],
      cells: [...match[0].matchAll(/<(td|th)\\b[\\s\\S]*?<\\/\\1>/gi)].map((cell) => decode(cell[0])),
    })).filter((row) => row.cells.length > 0 && row.cells.some(Boolean));
    const headerIndex = parsed.findIndex(({ html: rowHtml, cells }) => {
      const labels = cells.map(normalize);
      const headerLike = /<th\\b/i.test(rowHtml) || labels.some((label) => knownLabels.has(label));
      return headerLike && labels.filter(Boolean).every((label) => knownLabels.has(label));
    });
    const header = headerIndex >= 0 ? parsed[headerIndex]!.cells.map(normalize) : [];
    const courseColumn = header.findIndex((label) => courseLabels.has(label));
    const itemColumn = header.findIndex((label) => itemLabels.has(label));
    const gradeColumn = header.findIndex((label) => gradeLabels.has(label));

    for (let rowIndex = 0; rowIndex < parsed.length; rowIndex++) {
      if (rowIndex === headerIndex) continue;
      const cells = parsed[rowIndex]!.cells;
      if (cells.length < 2) continue;
      const normalizedCells = cells.map(normalize);
      if (
        normalizedCells.some((label) => courseLabels.has(label)) &&
        normalizedCells.some((label) => gradeLabels.has(label)) &&
        normalizedCells.every((label) => knownLabels.has(label) || !label)
      ) continue;

      let course = "General";
      let item = "";
      let grade = "";
      if (courseColumn >= 0 && gradeColumn >= 0) {
        course = cells[courseColumn] || course;
        item = itemColumn >= 0 ? cells[itemColumn] : header[gradeColumn] || "Grade";
        grade = cells[gradeColumn] ?? "";
      } else if (cells.length >= 3) {
        course = cells[0] || course;
        item = cells.slice(1, -1).filter(Boolean).join(" – ") || "Grade";
        grade = cells[cells.length - 1] ?? "";
      } else {
        item = cells[0] ?? "";
        grade = cells[1] ?? "";
      }
      if (!grade || gradeLabels.has(normalize(grade))) continue;

      const key = `${course}|${item}`;
      const count = seen.get(key) ?? 0;
      seen.set(key, count + 1);
      rows.push({ course, item: count ? `${item} (${count + 1})` : item, grade });
    }
  }
  return rows;
}
export async function fetchGrades(username: string, password: string): Promise<GradeRow[]> {
  const all: GradeRow[] = [];
  for (const p of GRADE_PATHS) {
    all.push(...parseGrades(await ntlmGet(p, username, password)));
  }
  return all;
}
