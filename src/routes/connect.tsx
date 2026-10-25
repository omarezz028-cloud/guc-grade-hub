import { useServerFn } from "@tanstack/react-start";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectToRitual } from "@/lib/ritual-connect.functions";

export const Route = createFileRoute("/connect")({
  validateSearch: (search: Record<string, unknown>) => ({
    state: typeof search.state === "string" ? search.state : "",
    return: typeof search.return === "string" ? search.return : "",
  }),
  head: () => ({
    meta: [
      { title: "Connect to Ritual — GradeWatch" },
      { name: "description", content: "Securely connect GUC grades to Ritual." },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: ConnectPage,
});

const RETURN_ORIGIN = "https://habit-buddy-app-47.lovable.app";

function validReturnUrl(value: string): boolean {
  try {
    return value.startsWith(RETURN_ORIGIN + "/") && new URL(value).origin === RETURN_ORIGIN;
  } catch {
    return false;
  }
}

function ConnectPage() {
  const { state, return: returnUrl } = Route.useSearch();
  const connectFn = useServerFn(connectToRitual);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const validRequest = /^[a-f0-9]{64}$/i.test(state) && validReturnUrl(returnUrl);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await connectFn({ data: { username, password, state, returnUrl } });
      setPassword("");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      window.location.replace(result.returnUrl);
    } catch (submitError) {
      setPassword("");
      setError(submitError instanceof Error ? submitError.message : "Could not connect to Ritual.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-10">
      <section className="ledger-card w-full max-w-md p-8">
        <p className="stamp text-primary">GradeWatch · GUC</p>
        <h1 className="mt-3 text-4xl">Connect to Ritual</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Sign in to GUC to link your grades. Your password is encrypted for scheduled GUC checks and is never shown to Ritual.
        </p>
        {!validRequest ? (
          <div role="alert" className="mt-6 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
            This connection link is invalid or expired. Start again from Ritual.
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-4">
            {error && (
              <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                {error}
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="guc-username">GUC username</Label>
              <Input
                id="guc-username"
                name="username"
                autoComplete="username"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="guc-password">GUC password</Label>
              <Input
                id="guc-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            <Button className="w-full" disabled={busy}>
              {busy ? "Signing in to GUC…" : "Connect securely"}
            </Button>
          </form>
        )}
        <p className="mt-5 text-xs text-muted-foreground">
          Your grades are sent directly to Ritual only when they are new or change.
        </p>
      </section>
    </main>
  );
}
