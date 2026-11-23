# Architecture: `bb-plugin-provider-antigravity`

## Goal and constraints
Register Google Antigravity (`providerId: "antigravity"`, `pluginId: "provider-antigravity"`) as a BB ACP provider whose live account quota appears in both `bb settings usage` (`system.usageLimits` -> host bridge `provider/usage`) and `bb--provider-usage` on desktop and mobile (`provider-usage.v1.listResources` / `getResource`). Existing threads on `acp-antigravity` (`provider-acp`) must remain untouched.

## Why native print-mode JSON replaced PTY
Live verification on `agy 1.5.15` showed that the documented non-interactive command:

```bash
agy -p "/usage" --output-format json --print-timeout 15s </dev/null
```

completes in ~1.8 s (`exit 0`, `num_turns: 0`, `total_tokens: 0`, `conversation_id: ""`), returns structured JSON (`command.data.groups[].buckets[]` with `id`, `name`, `window`, `remaining_fraction`, `reset_time`), and works even when interactive TUI onboarding has not been completed (`onboardingComplete: false`).

We therefore ship only the native print-mode JSON reader and drop the PTY/TUI layer (no Python helper, no `@xterm/headless`, no screen pagination, no interactive ToS exposure). If a future `agy` release disables print-mode slash expansion, `command` disappears from the JSON envelope and the reader returns a clear, immediate `error` naming the cause.

## Arena synthesis decision
- **Base:** Candidate B (print-mode JSON reader, pure domain types `ProviderQuota` -> `QuotaWindow[]`, zero host TTL cache, server-side 60 s cache + in-flight deduplication in `src/usage-source.ts`).
- **Dropped from B:** the dead env-gated PTY/TUI fallback and hand-written ANSI renderer; `reasoningCli: --effort` (unaccepted by `agy acp --help`).
- **Grafted from A and fixed during verification:**
  1. Forward `refresh` into `bb.sdk.system.usageLimits({ hostId, providerId, refresh })`.
  2. Clamp `usedPercent` to `0..100` (`Math.min(100, Math.max(0, round1((1 - remaining) * 100)))`) to match the bridge `providerUsageWindowSchema` contract.
  3. Resolve `agy` via `BB_ANTIGRAVITY_EXECUTABLE` -> `experimental_hostToolchain.resolve("agy")` -> `~/.local/bin/agy`, checking executable permission (`X_OK`).
  4. Preserve provider bucket IDs (`gemini-weekly`, `gemini-5h`, `3p-weekly`, `3p-5h`, `gemini-argon-wtu-weekly`) through bridge passthrough into `usage-source.ts` (fallback `${index}:${label}`).
  5. Keep `kind: "custom"` with concise period-first labels (`7d · Gemini`, `5h · Gemini`, `7d · Claude/GPT`, `5h · Claude/GPT`, `7d · Argon`) so `bb settings usage` and `bb--provider-usage` show identical text, React keys never collide, and narrow sidebar/mobile rows never truncate the period.
  6. Keep in-process `withSingleFlight` around `probeQuota` in `host.ts` so concurrent `bb settings usage --refresh` and `bb--provider-usage` calls share one `agy` process.
  7. Never read or log token contents (`existsSync` presence check on `~/.gemini/antigravity-cli/antigravity-oauth-token` avoids `agy`'s 60 s interactive OAuth wait); `readAccount()` never spawns.
