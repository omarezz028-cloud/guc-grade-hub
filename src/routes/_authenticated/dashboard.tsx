import { createFileRoute, useRouter } from "@tanstack/react-router";
import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { RefreshCw, Trash2, Copy, Eye, EyeOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  addWebhook,
  createApiKey,
  deleteApiKey,
  deleteWebhook,
  getDashboard,
  linkGucAccount,
  syncNow,
  testWebhooks,
  unlinkGucAccount,
} from "@/lib/guc.functions";

const dashQuery = queryOptions({ queryKey: ["dashboard"], queryFn: () => getDashboard(), retry: 2 });

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "My grades — GradeWatch" },
      { name: "description", content: "Your collected GUC grades, API keys and notifications." },
      { property: "og:title", content: "My grades — GradeWatch" },
      { property: "og:description", content: "Your collected GUC grades, API keys and notifications." },
    ],
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(dashQuery),
  component: Dashboard,
  errorComponent: DashboardError,
});

function DashboardError({ reset }: { reset: () => void }) {
  const router = useRouter();
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="ledger-card max-w-sm p-8 text-center">
        <h1 className="text-3xl">Couldn't load your grades</h1>
        <p className="mt-2 text-sm text-muted-foreground">The connection dropped. Please try again.</p>
        <Button className="mt-5" onClick={() => { router.invalidate(); reset(); }}>Try again</Button>
      </div>
    </main>
  );
}

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString() : "never");

function copy(text: string) {
  navigator.clipboard.writeText(text);
  toast.success("Copied");
}

function Dashboard() {
  const { data } = useSuspenseQuery(dashQuery);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ["dashboard"] });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between">
        <span className="stamp">GradeWatch · GUC</span>
        <Button variant="ghost" size="sm" onClick={() => supabase.auth.signOut()}>
          Sign out
        </Button>
      </header>
      {data.account ? (
        <Grades data={data} onChange={refresh} />
      ) : (
        <LinkAccount onDone={refresh} />
      )}
      {data.account && <Integrations data={data} onChange={refresh} />}
    </main>
  );
}

type Data = Awaited<ReturnType<typeof getDashboard>>;

function LinkAccount({ onDone }: { onDone: () => void }) {
  const link = useServerFn(linkGucAccount);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await link({ data: { username, password } }).catch(() => ({
      ok: false as const,
      error: "Connection dropped. Please try again.",
    }));
    setBusy(false);
    if (r.ok) {
      toast.success(`Linked! Found ${r.total} grade entries.`);
      onDone();
    } else toast.error(r.error);
  }

  return (
    <section className="mx-auto mt-16 max-w-md ledger-card p-8">
      <h1 className="text-4xl">Link your GUC account</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Use the same username and password you use for the GUC student portal. Your password is encrypted
        and only used to check your grades.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="gu">GUC username</Label>
          <Input id="gu" placeholder="first.last" required value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="gp">GUC password</Label>
          <div className="relative">
            <Input id="gp" type={show ? "text" : "password"} required className="pr-10" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button
              type="button"
              aria-label={show ? "Hide password" : "Show password"}
              onClick={() => setShow(!show)}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>
        <Button className="w-full" disabled={busy}>
          {busy ? "Checking the portal…" : "Link & collect grades"}
        </Button>
      </form>
    </section>
  );
}

function Grades({ data, onChange }: { data: Data; onChange: () => void }) {
  const sync = useServerFn(syncNow);
  const unlink = useServerFn(unlinkGucAccount);
  const [busy, setBusy] = useState(false);
  const byCourse = useMemo(() => {
    const m = new Map<string, Data["grades"]>();
    for (const g of data.grades) m.set(g.course, [...(m.get(g.course) ?? []), g]);
    return [...m.entries()];
  }, [data.grades]);

  async function run() {
    setBusy(true);
    const r = await sync().catch(() => ({ ok: false as const, error: "Connection dropped. Please try again." }));
    setBusy(false);
    if (r.ok) toast.success(r.changed ? `${r.changed} new or changed grades` : "No new grades");
    else toast.error(r.error);
    onChange();
  }

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-5xl">Your grades</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.account!.guc_username} · last checked {fmt(data.account!.last_synced_at)} · checks every few hours
          </p>
          {data.account!.last_error && (
            <p className="mt-1 text-sm text-destructive">Last check failed: {data.account!.last_error}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Button onClick={run} disabled={busy}>
            <RefreshCw className={busy ? "animate-spin" : ""} /> Check now
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              if (!confirm("Unlink your GUC account?")) return;
              await unlink();
              onChange();
            }}
          >
            Unlink
          </Button>
        </div>
      </div>
      {byCourse.length === 0 ? (
        <p className="mt-8 ledger-card p-6 text-muted-foreground">No grades published on the portal yet.</p>
      ) : (
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          {byCourse.map(([course, items]) => (
            <div key={course} className="ledger-card p-5">
              <h3 className="text-2xl">{course}</h3>
              <ul className="mt-3 divide-y">
                {items.map((g) => (
                  <li key={g.id} className="flex justify-between gap-4 py-2 text-sm">
                    <span>{g.item}</span>
                    <span className="font-mono font-semibold text-primary">{g.grade}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Integrations({ data, onChange }: { data: Data; onChange: () => void }) {
  const mkKey = useServerFn(createApiKey);
  const rmKey = useServerFn(deleteApiKey);
  const mkHook = useServerFn(addWebhook);
  const rmHook = useServerFn(deleteWebhook);
  const test = useServerFn(testWebhooks);
  const [keyName, setKeyName] = useState("");
  const [hookUrl, setHookUrl] = useState("");
  const [reveal, setReveal] = useState<{ label: string; value: string } | null>(null);
  const endpoint = typeof window !== "undefined" ? `${window.location.origin}/api/public/v1/grades` : "";

  return (
    <section className="mt-16 grid gap-6 md:grid-cols-2">
      <div className="ledger-card p-6">
        <h2 className="text-3xl">API link</h2>
        <p className="mt-1 text-sm text-muted-foreground">Other apps can read your grades from:</p>
        <button onClick={() => copy(endpoint)} className="mt-2 flex w-full items-center gap-2 rounded bg-muted p-2 text-left font-mono text-xs break-all">
          <Copy className="size-3 shrink-0" /> GET {endpoint}
        </button>
        <p className="mt-2 text-xs text-muted-foreground">
          Send header <code className="font-mono">Authorization: Bearer &lt;your key&gt;</code>
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await mkKey({ data: { name: keyName } });
            setReveal({ label: "Your new API key (shown once)", value: r.key });
            setKeyName("");
            onChange();
          }}
        >
          <Input placeholder="Key name, e.g. My bot" required value={keyName} onChange={(e) => setKeyName(e.target.value)} />
          <Button>Create key</Button>
        </form>
        <ul className="mt-4 divide-y text-sm">
          {data.keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between py-2">
              <span>
                {k.name} <span className="font-mono text-xs text-muted-foreground">{k.key_prefix}…</span>
                <span className="block text-xs text-muted-foreground">used {fmt(k.last_used_at)}</span>
              </span>
              <Button size="icon" variant="ghost" onClick={async () => { await rmKey({ data: { id: k.id } }); onChange(); }}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      </div>
      <div className="ledger-card p-6">
        <h2 className="text-3xl">New-grade notifications</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          We'll send a message to these links whenever a grade is added or changed.
        </p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await mkHook({ data: { url: hookUrl } });
              setReveal({ label: "Signing secret (shown once) — used to verify messages", value: r.secret });
              setHookUrl("");
              onChange();
            } catch {
              toast.error("Enter a valid https:// link");
            }
          }}
        >
          <Input placeholder="https://your-app.com/hook" required value={hookUrl} onChange={(e) => setHookUrl(e.target.value)} />
          <Button>Add</Button>
        </form>
        <ul className="mt-4 divide-y text-sm">
          {data.webhooks.map((h) => (
            <li key={h.id} className="flex items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block truncate font-mono text-xs">{h.url}</span>
                <span className="block text-xs text-muted-foreground">
                  last sent {fmt(h.last_called_at)} {h.last_status && `· ${h.last_status}`}
                </span>
              </span>
              <Button size="icon" variant="ghost" onClick={async () => { await rmHook({ data: { id: h.id } }); onChange(); }}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        {data.webhooks.length > 0 && (
          <Button variant="outline" size="sm" className="mt-3" onClick={async () => { await test(); toast.success("Test sent"); onChange(); }}>
            Send test notification
          </Button>
        )}
      </div>
      {reveal && (
        <div className="ledger-card p-5 md:col-span-2">
          <p className="stamp text-primary">{reveal.label}</p>
          <button onClick={() => copy(reveal.value)} className="mt-2 flex w-full items-center gap-2 rounded bg-muted p-2 font-mono text-sm break-all">
            <Copy className="size-4 shrink-0" /> {reveal.value}
          </button>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setReveal(null)}>Done</Button>
        </div>
      )}
    </section>
  );
}
