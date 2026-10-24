<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- GUC portal access lives in `src/server/*.server.ts` (custom NTLMv2 client + regex HTML parser); the portal uses Windows/NTLM login, so no cookie/form login.
- GUC passwords are stored only AES-GCM encrypted with the `GUC_ENC_KEY` secret; never return them to the browser.
- Grade writes, API-key and webhook inserts go through server functions using the admin client; users only get SELECT/DELETE via RLS.
- External apps use `/api/public/v1/grades` with hashed `guc_` API keys; single-grade webhooks use server-only Ritual bearer authorization and retain HMAC-SHA256 signing.
- Per-webhook grade delivery history and atomic leases prevent overlapping checks from repeating successful sends; failed deliveries retry on the next sync, and test sends never alter grade history. Existing grades are baselined when an address is added so historical grades are not replayed.
- Background checks run via the managed HTTP schedule calling `/api/public/jobs/sync-all`.
