import { useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
  useRpc,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import { poolPanelContract, readPanelMethod, type MachinePool } from "./src/pool-panel-contract.ts";

const POOL_ICON = "provider-antigravity/antigravity";
const POLL_MS = 60_000;

type Pool = NonNullable<MachinePool["pool"]>;
type PoolAccount = Pool["accounts"][number];
type Group = Extract<PoolAccount["quota"], { status: "ok" }>["groups"][number];
type Window = NonNullable<Group["fiveHour"]>;

const ACCOUNT_DIVIDER_CSS = `
[role="tabpanel"][aria-label*="usage"] section[aria-label] + section[aria-label] {
  border-top: 1px dashed var(--sidebar-border);
  padding-top: 0.625rem;
}
`;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

function barColor(percent: number) {
  return percent >= 95 ? "bg-destructive" : percent >= 80 ? "bg-warning" : "bg-primary";
}

function percentColor(percent: number) {
  return percent >= 95 ? "text-destructive" : percent >= 80 ? "text-warning" : "text-sidebar-foreground";
}

function untilReset(resetsAt: string | null, now: number) {
  if (resetsAt === null) return "—";
  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${minutes}m`;
}

function tighter(group: Group): Window {
  const windows = [group.fiveHour, group.weekly].filter((window): window is Window => window !== null);
  return windows.reduce((worst, window) => (window.usedPercent > worst.usedPercent ? window : worst));
}

function quotaProblem(account: PoolAccount): string | null {
  switch (account.quota.status) {
    case "ok":
      return null;
    case "signed-out":
      return `Not signed in. Run agy-pool login ${account.name}.`;
    case "expired":
      return `Sign-in expired. Run agy-pool login ${account.name}.`;
    case "not-installed":
      return "agy is not installed on this machine.";
    case "error":
      return account.quota.message;
  }
}

function threadsLine(account: PoolAccount) {
  const live = account.liveThreads === 0 ? "No live threads" : `${account.liveThreads} live thread${account.liveThreads === 1 ? "" : "s"}`;
  return `${live} · ${account.boundThreads} bound`;
}

function Badge({ children, title }: { children: string; title?: string }) {
  return (
    <span title={title} className="shrink-0 rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-muted-foreground">
      {children}
    </span>
  );
}

function routeBadge(account: PoolAccount) {
  const { route } = account;
  if (route.kind === "proxy") return <Badge title={route.endpoint}>proxy</Badge>;
  if (route.kind === "direct") return <Badge title="Server address">direct</Badge>;
  return <Badge title={route.problem}>broken proxy</Badge>;
}

function Bar({ percent }: { percent: number }) {
  return (
    <span className="block h-1 min-w-0 overflow-hidden rounded-full bg-sidebar-border">
      <span
        className={cx("block h-full rounded-full", barColor(percent))}
        style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
      />
    </span>
  );
}

function AccountSection({ account, isNext, now }: { account: PoolAccount; isNext: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const problem = quotaProblem(account);
  const groups = account.quota.status === "ok" ? account.quota.groups : [];
  const counted = groups.filter((group) => group.fiveHour !== null);
  return (
    <section
      aria-label={account.name}
      className="col-span-full grid grid-cols-subgrid gap-y-1.5 border-t border-sidebar-border pt-2.5 first:border-t-0 first:pt-0"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="col-span-full flex h-5 min-w-0 items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <h3 className="min-w-0 flex-1 truncate text-2xs font-medium text-sidebar-foreground">{account.name}</h3>
        {isNext ? <Badge title="The next new thread goes to this account">next</Badge> : null}
        {routeBadge(account)}
      </button>
      {account.email !== null ? <p className="col-span-full -mt-1 truncate text-2xs text-muted-foreground">{account.email}</p> : null}
      {problem !== null ? (
        <p className="col-span-full text-2xs text-muted-foreground">{problem}</p>
      ) : (
        counted.map((group) => {
          const worst = tighter(group);
          return (
            <span key={group.name} className="col-span-full grid grid-cols-subgrid items-center text-2xs">
              <span className="max-w-20 truncate text-muted-foreground">{group.name}</span>
              <span className="flex flex-col gap-0.5" title={`5h ${group.fiveHour?.usedPercent ?? 0}% · 7d ${group.weekly?.usedPercent ?? 0}%`}>
                <Bar percent={group.fiveHour?.usedPercent ?? 0} />
                <Bar percent={group.weekly?.usedPercent ?? 0} />
              </span>
              <span className={cx("text-right tabular-nums", percentColor(worst.usedPercent))}>{Math.round(worst.usedPercent)}%</span>
              <span className="min-w-9 text-right tabular-nums text-muted-foreground">{untilReset(worst.resetsAt, now)}</span>
            </span>
          );
        })
      )}
      <p className="col-span-full text-2xs text-muted-foreground">{threadsLine(account)}</p>
      {open ? (
        <div className="col-span-full flex flex-col gap-1 text-2xs text-muted-foreground">
          {groups.flatMap((group) =>
            (
              [
                ["5h", group.fiveHour],
                ["7d", group.weekly],
              ] as const
            ).flatMap(([span, window]) =>
              window === null
                ? []
                : [
                    <span key={`${group.name}-${span}`} className="flex justify-between gap-2">
                      <span>
                        {span} · {group.name}
                      </span>
                      <span className="tabular-nums text-sidebar-foreground">
                        {Math.round(window.usedPercent)}% · resets in {untilReset(window.resetsAt, now)}
                      </span>
                    </span>,
                  ],
            ),
          )}
          {account.route.kind === "proxy" ? (
            <span className="flex justify-between gap-2">
              <span>Exit</span>
              <span className="tabular-nums text-sidebar-foreground">{account.route.endpoint}</span>
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PoolNotice({ pool }: { pool: Pool }) {
  if (pool.next !== null) return null;
  const signedIn = pool.accounts.some((account) => account.quota.status === "ok");
  return (
    <p className="col-span-full mb-1 text-2xs text-warning">
      {signedIn ? "Every account is out of quota." : "No account is signed in."}
    </p>
  );
}

function PoolPanel({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const query = useRpcQuery({ contract: poolPanelContract, method: readPanelMethod, input: { refresh: false } });
  const rpc = useRpc<typeof poolPanelContract>();
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void query.refetch();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [query.refetch]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await rpc.call(readPanelMethod, { refresh: true });
      await query.refetch();
    } finally {
      setNow(Date.now());
      setRefreshing(false);
    }
  };

  const machines = (query.data?.machines ?? []).filter(
    (machine) => machine.pool?.accounts.some((account) => account.quota.status !== "signed-out") ?? machine.error !== null,
  );
  const machine = machines.find((candidate) => candidate.id === selected) ?? machines[0] ?? null;
  const pool = machine?.pool ?? null;
  const busy = refreshing || query.isFetching;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5">
        <span className="px-1.5 text-2xs font-medium text-sidebar-foreground">Antigravity pool</span>
        <span className="flex min-w-0 flex-1 justify-end gap-0.5 overflow-x-auto">
          {machines.length > 1
            ? machines.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => setSelected(candidate.id)}
                  className={cx(
                    "h-6 shrink-0 rounded-md px-1.5 text-2xs",
                    candidate.id === machine?.id ? "bg-sidebar-accent text-sidebar-foreground" : "text-muted-foreground hover:bg-sidebar-accent",
                  )}
                >
                  {candidate.name}
                </button>
              ))
            : machine !== null
              ? <span className="truncate px-1.5 text-2xs text-muted-foreground">{machine.name}</span>
              : null}
        </span>
        <button
          type="button"
          aria-label="Refresh pool"
          onClick={() => void refresh()}
          disabled={busy}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-60"
        >
          <Icon name="RotateCcw" className={cx("size-3.5", busy && "animate-spin [animation-direction:reverse]")} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Collapse pool"
          onClick={dismiss}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Icon name="ChevronDown" className="size-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto p-2.5">
        {pool === null ? (
          query.isLoading || busy ? (
            <div className="flex flex-col gap-2">
              {[0, 1].map((row) => (
                <div key={row} className="h-16 animate-pulse rounded-md bg-sidebar-border/50" />
              ))}
            </div>
          ) : (
            <p className="text-2xs text-muted-foreground">{machine?.error ?? "No Antigravity pool on a connected machine."}</p>
          )
        ) : (
          <div className="grid grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] gap-x-3 gap-y-2.5">
            {machine?.error ? <p className="col-span-full text-2xs text-muted-foreground">{machine.error} Showing last update.</p> : null}
            <PoolNotice pool={pool} />
            {pool.accounts.map((account) => (
              <AccountSection key={account.name} account={account} isNext={account.name === pool.next} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "pool",
    label: "Antigravity pool",
    icon: POOL_ICON,
    component: PoolPanel,
  });
  app.contentScripts.register({
    id: "usage-account-divider",
    mount() {
      const style = document.createElement("style");
      style.textContent = ACCOUNT_DIVIDER_CSS;
      document.head.append(style);
      return () => style.remove();
    },
  });
});
