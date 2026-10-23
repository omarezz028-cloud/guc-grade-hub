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

function attr(attrs: string, name: string): string | null {
  const match = new RegExp("\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i").exec(attrs);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function mergeCookies(...headers: string[][]): string {
  const cookies = new Map<string, string>();
  for (const values of headers) {
    for (const value of values) {
      const pair = value.split(";", 1)[0] ?? "";
      const separator = pair.indexOf("=");
      if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }
  return [...cookies].map(([name, value]) => name + "=" + value).join("; ");
}

function coursePostback(html: string, currentPath: string): { path: string; body: string } | null {
  const form = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const formAttrs = form[1] ?? "";
  const formBody = form[2] ?? "";
  const selects = [...formBody.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)];
  const select = selects.find((match) => /course|class|subject|semester/i.test(attr(match[1] ?? "", "name") ?? attr(match[1] ?? "", "id") ?? "")) ?? selects[0];
  if (!select) return null;
  const selectAttrs = select[1] ?? "";
  const selectName = attr(selectAttrs, "name");
  if (!selectName) return null;
  const options = [...(select[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
  const option = options.find((match) => attr(match[1] ?? "", "selected") !== null) ?? options[0];
  if (!option) return null;
  const selectedValue = attr(option[1] ?? "", "value") ?? decode(option[2] ?? "");
  const formAction = attr(formAttrs, "action") ?? currentPath;
  let action: URL;
  try {
    action = new URL(formAction, BASE + currentPath);
  } catch {
    return null;
  }
  if (action.origin !== BASE) return null;

  const fields = new URLSearchParams();
  for (const input of formBody.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = input[1] ?? "";
    const name = attr(attrs, "name");
    if (!name) continue;
    const type = (attr(attrs, "type") ?? "text").toLowerCase();
    if (type === "hidden") fields.append(name, decode(attr(attrs, "value") ?? ""));
  }
  fields.set(selectName, selectedValue);
  fields.set("__EVENTTARGET", attr(selectAttrs, "name") ?? attr(selectAttrs, "id") ?? "");
  fields.set("__EVENTARGUMENT", "");
  return { path: action.pathname + action.search, body: fields.toString() };
}

async function ntlmGet(path: string, rawUser: string, password: string): Promise<string> {
  const { user, domain } = splitUser(rawUser);
  const conn = new KeepAliveConnection(new URL(BASE).host);
  try {
    let r1;
    try {
      r1 = await conn.request("GET", path, { Authorization: "NTLM " + ntlmType1() });
    } catch {
      throw new GucError("Could not reach the GUC portal.", "unreachable");
    }
    const auth = (r1.headers["www-authenticate"] ?? []).join(", ");
    const challenge = /NTLM\s+([A-Za-z0-9+/=]{20,})/.exec(auth);
    if (!challenge) {
      throw new GucError(
        "GUC portal did not start a login handshake (status " + r1.status + ").",
        "unexpected",
      );
    }
    const cookie1 = mergeCookies(r1.headers["set-cookie"] ?? []);
    const r2 = await conn.request("GET", path, {
      Authorization: "NTLM " + ntlmType3(challenge[1]!, user, password, domain),
      ...(cookie1 ? { Cookie: cookie1 } : {}),
    });
    if (r2.status === 401) {
      throw new GucError("GUC rejected the username or password.", "bad_credentials");
    }
    if (r2.status < 200 || r2.status >= 300) {
      throw new GucError("GUC portal returned status " + r2.status + ".", "unexpected");
    }

    const postback = coursePostback(r2.body, path);
    if (!postback) return r2.body;
    const cookies = mergeCookies(r1.headers["set-cookie"] ?? [], r2.headers["set-cookie"] ?? []);
    const r3 = await conn.request("POST", postback.path, {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: BASE + path,
      ...(cookies ? { Cookie: cookies } : {}),
    }, postback.body);
    if (r3.status === 401) {
      throw new GucError("GUC rejected the course-selection postback (HTTP 401). Please unlink and relink your GUC account if this continues.", "unexpected");
    }
    if (r3.status < 200 || r3.status >= 300) {
      throw new GucError("GUC portal returned status " + r3.status + ".", "unexpected");
    }
    return r3.body;
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
  const tables = [...html.matchAll(/<table\b((?:(?!<table\b)[\s\S])*?)<\/table>/gi)].map((m) => m[1] ?? "");
  const preferred = tables.filter((t) => /id="[^"]*(midDg|grade|Dg)[^"]*"/i.test(t.split(">")[0] ?? ""));
  const chosen = preferred.length ? preferred : tables;
  const rows: GradeRow[] = [];
  const seen = new Map<string, number>();
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
  const courseLabels = new Set(["course", "course code", "course name", "subject", "subject code"]);
  const itemLabels = new Set(["item", "assessment", "component", "exam", "exam type", "grade item"]);
  const gradeLabels = new Set(["grade", "percentage", "percent", "mark", "marks", "score", "result", "obtained"]);
  const quizLabels = new Set(["quiz assignment"]);
  const elementLabels = new Set(["element name"]);
  const knownLabels = new Set([...courseLabels, ...itemLabels, ...gradeLabels, ...quizLabels, ...elementLabels, "prof lecturer ta", "date", "type"]);
  const selectedCourse = decode(
    [...html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
      .find((match) => /\bselected(?:\s|=|>)/i.test(match[1] ?? ""))?.[2] ?? "",
  );

  // ASP.NET can nest layout tables around its GridView. Parse the grade rows
  // from the document as a fallback so the nested table boundary cannot hide them.
  const documentRows = [...html.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => ({
    html: match[0],
    cells: [...match[0].matchAll(/<(td|th)\b[\s\S]*?<\/\1>/gi)].map((cell) => decode(cell[0])),
  })).filter((row) => row.cells.length > 0);
  const quizHeaderIndex = documentRows.findIndex(({ cells }) => {
    const labels = cells.map(normalize);
    return labels.includes("quiz assignment") && labels.includes("element name") && labels.includes("grade");
  });
  if (quizHeaderIndex >= 0) {
    const header = documentRows[quizHeaderIndex]!.cells.map(normalize);
    const quizColumn = header.indexOf("quiz assignment");
    const elementColumn = header.indexOf("element name");
    const gradeColumn = header.indexOf("grade");
    for (const row of documentRows.slice(quizHeaderIndex + 1)) {
      const labels = row.cells.map(normalize);
      if (labels.includes("quiz assignment") && labels.includes("element name") && labels.includes("grade")) break;
      if (row.cells.length <= Math.max(quizColumn, elementColumn, gradeColumn)) continue;
      const item = [row.cells[quizColumn], row.cells[elementColumn]].filter(Boolean).join(" – ");
      const grade = row.cells[gradeColumn] ?? "";
      if (!item || !grade) continue;
      const course = selectedCourse || "General";
      const key = course + "|" + item;
      const count = seen.get(key) ?? 0;
      seen.set(key, count + 1);
      rows.push({ course, item: count ? item + " (" + (count + 1) + ")" : item, grade });
    }
    if (rows.length) return rows;
  }

  for (const table of chosen) {
    const parsed = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => ({
      html: match[0],
      cells: [...match[0].matchAll(/<(td|th)\b[\s\S]*?<\/\1>/gi)].map((cell) => decode(cell[0])),
    })).filter((row) => row.cells.length > 0 && row.cells.some(Boolean));
    const headerIndex = parsed.findIndex(({ html: rowHtml, cells }) => {
      const labels = cells.map(normalize);
      const headerLike = /<th\b/i.test(rowHtml) || labels.some((label) => knownLabels.has(label));
      return headerLike && labels.filter(Boolean).every((label) => knownLabels.has(label));
    });
    const header = headerIndex >= 0 ? parsed[headerIndex]!.cells.map(normalize) : [];
    const courseColumn = header.findIndex((label) => courseLabels.has(label));
    const itemColumn = header.findIndex((label) => itemLabels.has(label));
    const gradeColumn = header.findIndex((label) => gradeLabels.has(label));
    const quizColumn = header.findIndex((label) => quizLabels.has(label));
    const elementColumn = header.findIndex((label) => elementLabels.has(label));
    const isQuizAssignmentTable = quizColumn >= 0 && elementColumn >= 0 && gradeColumn >= 0;

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
      if (isQuizAssignmentTable) {
        course = selectedCourse || course;
        item = [cells[quizColumn], cells[elementColumn]].filter(Boolean).join(" – ");
        grade = cells[gradeColumn] ?? "";
      } else if (courseColumn >= 0 && gradeColumn >= 0) {
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

      const key = course + "|" + item;
      const count = seen.get(key) ?? 0;
      seen.set(key, count + 1);
      rows.push({ course, item: count ? item + " (" + (count + 1) + ")" : item, grade });
    }
  }
  return rows;
}
export async function fetchGrades(username: string, password: string): Promise<GradeRow[]> {
  const all: GradeRow[] = [];
  for (const p of GRADE_PATHS) {
    const html = await ntlmGet(p, username, password);
    const parsed = parseGrades(html);
    all.push(...parsed);
    if (parsed.length === 0) {
      // Return only structural counts/booleans; never include portal content or personal data.
      const tableCount = [...html.matchAll(/<table\b/gi)].length;
      const rowCount = [...html.matchAll(/<tr\b/gi)].length;
      const hasQuizHeader = /quiz\s*\/?\s*assignment/i.test(html);
      const hasElementHeader = /element\s+name/i.test(html);
      const hasGradeHeader = /grade/i.test(html);
      const hasSelectedCourse = [...html.matchAll(/<option\b([^>]*)>/gi)]
        .some((match) => /\bselected(?:\s|=|>)/i.test(match[1] ?? ""));
      throw new GucError(
        `GUC page loaded, but no grade rows were parsed (tables: ${tableCount}, rows: ${rowCount}, quiz header: ${hasQuizHeader}, element header: ${hasElementHeader}, grade header: ${hasGradeHeader}, course selected: ${hasSelectedCourse}).`,
        "unexpected",
      );
    }
  }
  return all;
}
