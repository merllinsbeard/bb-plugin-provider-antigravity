# Google Antigravity Provider for bb

Connects [Google Antigravity](https://antigravity.google) (`agy` CLI) to [bb](https://getbb.app) as a single ACP provider with multi-account quota pooling, per-account proxy routing, and live usage limits inside bb's native usage card.

## Features

- **One provider, N accounts.** Several Google accounts sit behind the single `antigravity` provider in bb's model picker.
- **Automatic quota-aware rotation & failover.** When a new bb thread starts, the launcher reads live 5-hour and weekly quotas across all signed-in accounts (Gemini and Claude/GPT model groups) and picks the account with the most headroom. Ties go to the account with fewer live threads. If the active account runs out of quota mid-session, the relay fails over seamlessly to another account with headroom for that model family (Gemini or Claude/GPT); an account out of one family keeps serving the other. When every account is out of the thread's family, the turn fails with the pool's reason and nearest reset instead of passing agy's refusal off as a reply.
- **Hand-off when the whole pool is out.** A visible top-level thread that fails this way continues by itself in a new thread in the same environment, on Claude Code Opus 5.5 Medium by default, whose prompt starts with `Continue from @thread:<id>`, as bb's own "Hand off to new thread" does. Child threads are left to their parent agent and plugin-started threads to their plugin, so one failure never has two actors relaunching it; each failure hands off at most once, recorded in the failed thread's plugin metadata. Change the target or turn it off with `bb plugin config provider-antigravity set quotaHandoffProvider|quotaHandoffModel|quotaHandoffReasoning <value>` and `set quotaHandoff false`.
- **Sticky thread bindings with shared history.** Each thread stays bound to the account it started on (`~/.local/state/agy-pool/bindings.json`), while conversation stores (`conversations/`, `brain/`, `annotations/`) are shared so threads can fail over without losing history.
- **Isolated accounts, shared config.** Extra accounts run in a narrow `bwrap` bind over `~/.gemini/antigravity-cli` (stored in `~/.local/share/agy-accounts/<name>/`), while `~/.gemini/config` (MCP servers, hooks, skills) and `~/.gemini/AGENTS.md` stay shared. Native skill roots (`.agents/skills`, `.gemini/skills`, `.gemini/antigravity/skills`) are declared for bb's composer.
- **Per-account fail-closed proxy.** Any account can own a dedicated `http`, `https`, or `socks5` proxy. Both agent traffic and quota probes leave through that proxy, while local and tailnet hosts stay direct via `NO_PROXY`. If the proxy goes down or its config is malformed, `agy` refuses to start instead of leaking the host IP.
- **Native bb usage view.** Each pool account appears as its own block in bb's usage panel and `bb settings usage`, showing its Google email, route badge (`default · direct`, `acc2 · proxy`), and live 5h/7d bars for Gemini, Claude/GPT, and Argon. An **All accounts** block on top sums each weekly limit over the pool: its bar is the mean use of the measured accounts, its reset is the earliest one, and its badge says how many accounts were measured.
- **Opus by default.** New threads start on Claude Opus 5.5 at Medium reasoning instead of agy's own pick (`src/default-model.ts`).

## Requirements

- `bb` 0.49 or later.
- Google Antigravity CLI (`agy`) installed on the bb host (`PATH`, `~/.local/bin/agy`, or `BB_ANTIGRAVITY_EXECUTABLE`).
- Node.js 22+ (native TypeScript execution for `bin/agy-pool`).
- Linux with `bwrap` (`bubblewrap`) for multi-account isolation (`sudo apt install bubblewrap` on Debian/Ubuntu). A single `default` account works without `bwrap`.

## Install

```sh
bb plugin install git:https://github.com/merllinsbeard/bb-plugin-provider-antigravity.git
```

Or clone the repository locally and install by path (handy if you want `bin/agy-pool` in a fixed location):

```sh
git clone https://github.com/merllinsbeard/bb-plugin-provider-antigravity.git
bb plugin install path:./bb-plugin-provider-antigravity
```

## Setup

### 1. Sign in to the default account

```sh
agy acp --login
```

With one signed-in account the plugin works immediately without probing overhead.

### 2. Add pool accounts (with optional per-account proxies)

Use `bin/agy-pool` from the plugin directory (or symlink it onto your `PATH`):

```sh
# Add an account routed through its own proxy
./bin/agy-pool login acc2 --proxy "http://user:pass@host:port"

# Add an account without a proxy (direct)
./bin/agy-pool login acc3
```

When `--proxy` is passed, `agy-pool login` saves the proxy URL to `~/.local/share/agy-accounts/<name>/agy-pool-proxy` (mode `0600`), verifies the exit IP and country through that proxy first, and only then starts `agy acp --login` through it. If the proxy check fails, sign-in does not run.

Supported proxy schemes: `http://`, `https://`, and `socks5://` (credentials allowed).

### 3. Inspect and sync the pool

```sh
./bin/agy-pool list
./bin/agy-pool sync
```

`list` prints JSON with every account's sign-in state, egress route (`direct`, `proxy host:port`, or `unusable`), bound and live thread counts, and live quota windows. `sync` propagates `settings.json` from the default account to every added pool account and migrates any unshared conversation folders without touching auth tokens or proxy files.

### 4. One-shot runs (`agy -p`)

Anything other than `agy-pool acp` runs agy once on the pool, so scripts get the same balancing as threads:

```bash
agy-pool -p "Generate one image of a red apple" --model gemini-3.8-flash-low --output-format json
```

The run starts on the account with the most room for the family of `--model` (all families when it is omitted) and records no thread binding, so a Claude Code thread that shells out to it is never bound to an account. In print mode (`-p`, `--print`, `--prompt`) a run agy refuses for quota marks that account until the reset agy named and runs again on the next one; only the last run's stdout reaches the caller, and when no account is left, the caller gets agy's refusal plus the pool's reason with the nearest reset on stderr. `AGY_POOL_ACCOUNT` pins the run to one account and turns this off. baoyu-image-gen's `antigravity` provider draws through this path.

### 5. Override account selection (optional)

Set `AGY_POOL_ACCOUNT=<name>` to force a specific account without recording a thread binding.

## Environment variables

- `BB_ANTIGRAVITY_EXECUTABLE` — explicit path to the `agy` binary.
- `AGY_POOL_ACCOUNTS_DIR` — override `~/.local/share/agy-accounts`.
- `AGY_POOL_STATE_DIR` — override `~/.local/state/agy-pool`.
- `AGY_POOL_ACCOUNT` — force one pool account for a single invocation.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

See [docs/architecture.md](docs/architecture.md) for the full design of the quota reader, account pool, isolation, and fail-closed proxy routing.

## License

MIT
