import { beforeEach, describe, expect, it, vi } from "vitest";
import { gradePayload, isPublicNotificationUrl, postGradeNotification } from "@/lib/grade-notifications";

const state = vi.hoisted(() => ({
  sent: new Map<string, string>(), leases: new Map<string, string>(),
  status: "", calls: [] as string[], response: 200,
}));

vi.mock("@/server/guc.server", () => ({ GucError: Error }));
vi.mock("@/server/crypto.server", () => ({}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      let update: Record<string, unknown> = {};
      const filters: Record<string, string> = {};
      const chain = {
        select: () => chain,
        update: (values: Record<string, unknown>) => { update = values; return chain; },
        eq: (key: string, value: string) => { filters[key] = value; return chain; },
        then: (resolve: (value: unknown) => void) => {
          if (table === "webhooks" && !Object.keys(update).length) {
            resolve({ data: [{ id: "hook", url: "https://receiver.example/hook", signing_secret: "test-only" }], error: null });
          } else {
            if (table === "webhooks") state.status = String(update['last_status']);
            else {
              const key = `${filters['course']}|${filters['item']}`;
              if (state.leases.get(key) === filters['lease_token']) {
                state.leases.delete(key);
                if (typeof update['sent_grade'] === "string") state.sent.set(key, update['sent_grade']);
              }
            }
            resolve({ error: null });
          }
        },
      };
      return chain;
    },
    rpc: async (_name: string, args: { p_course: string; p_item: string; p_grade: string; p_token: string }) => {
      const key = `${args.p_course}|${args.p_item}`;
      if (state.sent.get(key) === args.p_grade || state.leases.has(key)) return { data: false, error: null };
      state.leases.set(key, args.p_token);
      return { data: true, error: null };
    },
  },
}));

import { sendWebhooks } from "@/server/sync.server";

const row = { course: "Mathematics", item: "Quiz 1", grade: "8/10" };

beforeEach(() => {
  state.sent.clear(); state.leases.clear(); state.calls = []; state.status = ""; state.response = 200;
  vi.stubEnv("RITUAL_SECRET", crypto.randomUUID());
  vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => {
    state.calls.push(String(options.body));
    return new Response(null, { status: state.response });
  }));
});

describe("Outgoing grade notifications", () => {
  it("sends exactly the requested course, item and score / max JSON", () => {
    expect(gradePayload(row)).toEqual({ course: "Mathematics", item: "Quiz 1", grade: "8 / 10" });
  });

  it("uses POST and bearer authorization without following redirects", async () => {
    let correctHeader = false;
    let method: string | undefined;
    let redirect: RequestRedirect | undefined;
    const secret = crypto.randomUUID();
    const request = vi.fn(async (_url: unknown, options?: RequestInit) => {
      correctHeader = new Headers(options?.headers).get("Authorization") === `Bearer ${secret}`;
      method = options?.method;
      redirect = options?.redirect;
      return new Response(null, { status: 202 });
    });
    const result = await postGradeNotification("https://receiver.example/hook", row, secret, "test", () => "test", request);
    expect(correctHeader).toBe(true);
    expect(method).toBe("POST");
    expect(redirect).toBe("manual");
    expect(result).toEqual({ ok: true, status: "HTTP 202" });
  });

  it("sends a new grade once and remembers it across checks", async () => {
    await sendWebhooks("user", [row]);
    await sendWebhooks("user", [row]);
    expect(state.calls).toHaveLength(1);
    expect(state.sent.get("Mathematics|Quiz 1")).toBe("8/10");
  });

  it("sends a changed score once", async () => {
    state.sent.set("Mathematics|Quiz 1", "8/10");
    await sendWebhooks("user", [{ ...row, grade: "9/10" }]);
    await sendWebhooks("user", [{ ...row, grade: "9/10" }]);
    expect(state.calls).toEqual([JSON.stringify({ course: "Mathematics", item: "Quiz 1", grade: "9 / 10" })]);
  });

  it("retries failed delivery and records the actual response status", async () => {
    state.response = 503;
    await sendWebhooks("user", [row]);
    expect(state.sent.size).toBe(0);
    expect(state.status).toBe("HTTP 503");
    state.response = 200;
    await sendWebhooks("user", [row]);
    expect(state.calls).toHaveLength(2);
    expect(state.sent.get("Mathematics|Quiz 1")).toBe("8/10");
  });

  it("does not duplicate sends during overlapping checks", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url, options: RequestInit) => {
      state.calls.push(String(options.body));
      await new Promise(resolve => setTimeout(resolve, 20));
      return new Response(null, { status: 200 });
    }));
    await Promise.all([sendWebhooks("user", [row]), sendWebhooks("user", [row])]);
    expect(state.calls).toHaveLength(1);
  });

  it("test sends return status without changing real grade history", async () => {
    state.response = 201;
    const results = await sendWebhooks("user", [{ course: "TEST 101", item: "Test notification", grade: "10 / 10" }], "hook");
    expect(results[0]).toEqual({ id: "hook", ok: true, status: "HTTP 201" });
    expect(state.sent.size).toBe(0);
  });

  it("rejects private addresses and credential-bearing URLs", () => {
    expect(isPublicNotificationUrl("https://127.0.0.1/hook")).toBe(false);
    expect(isPublicNotificationUrl("https://localhost/hook")).toBe(false);
    expect(isPublicNotificationUrl("https://user:pass@receiver.example/hook")).toBe(false);
    expect(isPublicNotificationUrl("https://receiver.example/hook")).toBe(true);
  });
});