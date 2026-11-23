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

## Account pool: one Antigravity account per thread
Several Google accounts serve BB as the one `antigravity` provider. Each thread is bound to one account when it first starts and stays on it, because agy keeps conversation history per account.

### Pieces
- **Accounts** (`src/pool/account.ts`). The built-in `default` account is the existing `~/.gemini/antigravity-cli`, used without any bind. Every added account is a folder `~/.local/share/agy-accounts/<name>/` (`AGY_POOL_ACCOUNTS_DIR` overrides the root). An account without `antigravity-oauth-token` is unauthenticated and never picked.
- **Bindings** (`src/pool/bindings.ts`). `~/.local/state/agy-pool/bindings.json` (`AGY_POOL_STATE_DIR` overrides) maps `threadId -> { account, pid, boundAt }`. It is written atomically (temp file and rename) under `flock` on `bindings.lock`, so two threads that start together see each other's choice. It lives outside BB's plugin data directory because the launcher and `agy-pool list` run outside the plugin process, and because BB deletes plugin files on uninstall while the account folders and the conversations they hold survive.
- **Pick** (`src/pool/pick.ts`). A model group counts when it has both a 5-hour and a weekly bucket (today Gemini and Claude/GPT; the weekly-only Argon group does not count). Its value is the smaller remaining fraction of the two, and an account scores its best group. The highest score wins; a tie goes to the account with fewer live threads (bound pid alive and its `/proc/<pid>/environ` carries that `BB_THREAD_ID`). An account whose quota could not be read ranks below every account with known room. When every account scores zero, the launcher exits 1 naming the nearest reset. With a single signed-in account the launcher binds it without probing, so a one-account machine starts threads as fast as before.
- **Launcher** `bin/agy-pool`, set as `acpLaunchSpec.command` by absolute path (resolved from the bundle's `import.meta.url`). It is bash so it can `exec` the final command: agy (or bwrap) keeps the launcher's pid, stdio, and exit code. The decision runs in `src/pool/cli.ts` under `/usr/bin/node`, which strips TypeScript types natively; that is why relative imports use `.ts` paths. `AGY_POOL_ACCOUNT=<name>` forces an account and records no binding; without `BB_THREAD_ID` the launcher uses `default`. Overhead is about 0.3 s per thread start (measured: `agy-pool --version`).
- **Commands.** `agy-pool login <name>` creates the folder, copies `settings.json` from the default account, and runs `agy acp --login` inside the bind. `agy-pool list` prints every account with its sign-in state, quota windows, bound thread count, and live thread count as JSON.
- **Usage card** (`src/usage/dialect.ts`). With only `default` present the probe and labels are exactly as before. With more accounts each account is probed in turn (inside the existing single-flight and 60 s server cache), and every window gets the account name as a prefix in its label and id (`alt 5h · Gemini`, `alt:gemini-5h`). Unauthenticated accounts are skipped without spawning agy.

### Isolation: narrow bind, verified on merlinde with agy 1.5.15
- `bwrap --dev-bind / / --bind <account> ~/.gemini/antigravity-cli agy ...` with an empty folder makes agy ask for a Google sign-in, so the narrow bind separates accounts. `~/.gemini/config` (MCP, hooks, skills) and `~/.gemini/AGENTS.md` stay shared: agy populated the empty account's `mcp/` from the shared config on first start. `HOME` stays `/home/merlin`, and `git config user.name` inside the bind matches the host's.
- agy's native `--app-data-dir` was checked first. `agy acp` accepts it, but it joins the value under `~/.gemini` and print mode rejects the flag (exit 2), and the quota probe needs print mode. bwrap covers both modes with one mechanism.
- `agy --sandbox` still works inside the bind: a command run by agy's terminal tool sees `/etc` as a read-only file system and 175 mounts, against `Permission denied` and 136 mounts inside the same bind without `--sandbox`.
- Process lifetime. bwrap stays the parent of agy and does not forward signals, but BB starts ACP agents in their own process group and stops them with SIGTERM to the leader, then SIGTERM to the whole group, then SIGKILL (`stopProcessGroupLeaderFirst` in the SDK). agy inside the bind therefore receives SIGTERM and shuts down cleanly; `tests/pool.test.ts` replays that sequence. `--die-with-parent` is deliberately absent because it would SIGKILL agy before the group SIGTERM arrives.
