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
  if (days > 0) return hours > 0 ? `${days}д ${hours}ч` : `${days}д`;
  if (hours > 0) return `${hours}ч ${minutes % 60}м`;
  return `${minutes}м`;
}

function ago(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "только что" : `${minutes} мин назад`;
}

function plural(count: number, one: string, few: string, many: string) {
  const tens = count % 100;
  const ones = count % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (ones === 1) return one;
  if (ones >= 2 && ones <= 4) return few;
  return many;
}

function hue(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
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
      return `Вход не выполнен. Запусти agy-pool login ${account.name}.`;
    case "expired":
      return `Вход истёк. Запусти agy-pool login ${account.name}.`;
    case "not-installed":
      return "agy не установлен на этой машине.";
    case "error":
      return account.quota.message;
  }
}

function Bar({ percent, label }: { percent: number; label: string }) {
  return (
    <span title={label} className="block h-1 min-w-0 overflow-hidden rounded-full bg-sidebar-border">
      <span
        className={cx("block h-full rounded-full transition-[width] duration-500", barColor(percent))}
        style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
      />
    </span>
  );
}

function RouteChip({ account }: { account: PoolAccount }) {
  const { route } = account;
  const healthy = account.quota.status === "ok";
  const [dot, text, title] =
    route.kind === "proxy"
      ? [healthy ? "bg-emerald-500" : "bg-destructive", "прокси", `Выход через ${route.endpoint}`]
      : route.kind === "direct"
        ? ["bg-muted-foreground/50", "напрямую", "Выход с адреса сервера"]
        : ["bg-destructive", "прокси сломан", route.problem];
  return (
    <span
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-full border border-sidebar-border px-1.5 py-0.5 text-2xs leading-none text-muted-foreground"
    >
      <span className={cx("size-1.5 rounded-full", dot)} />
      {text}
    </span>
  );
}

function AccountCard({ account, isNext, now }: { account: PoolAccount; isNext: boolean; now: number }) {
  const [open, setOpen] = useState(false);
  const problem = quotaProblem(account);
  const groups = account.quota.status === "ok" ? account.quota.groups : [];
  const main = groups.filter((group) => group.fiveHour !== null);
  const color = `hsl(${hue(account.name)} 55% 48%)`;
  return (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      className={cx(
        "flex w-full flex-col gap-2 rounded-lg border p-2.5 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        isNext
          ? "border-primary/40 bg-primary/[0.04] hover:border-primary/60"
          : "border-sidebar-border hover:border-muted-foreground/40",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-2xs font-semibold text-white"
          style={{ backgroundColor: color }}
        >
          {account.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-xs font-medium leading-tight text-sidebar-foreground">
            {account.name}
            {isNext ? (
              <span className="rounded-sm bg-primary/15 px-1 py-px text-[0.625rem] font-semibold uppercase leading-none tracking-wide text-primary">
                next
              </span>
            ) : null}
          </span>
          <span className="truncate text-2xs leading-tight text-muted-foreground">{account.email ?? "почта неизвестна"}</span>
        </span>
        <RouteChip account={account} />
      </span>

      {problem !== null ? (
        <span className="text-2xs text-muted-foreground">{problem}</span>
      ) : (
        <span className="grid grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] items-center gap-x-3 gap-y-1.5">
          {main.map((group) => {
            const worst = tighter(group);
            return (
              <span key={group.name} className="col-span-full grid grid-cols-subgrid items-center text-2xs">
                <span className="text-muted-foreground">{group.name}</span>
                <span className="flex flex-col gap-0.5">
                  <Bar percent={group.fiveHour?.usedPercent ?? 0} label={`5ч: ${group.fiveHour?.usedPercent ?? 0}%`} />
                  <Bar percent={group.weekly?.usedPercent ?? 0} label={`7д: ${group.weekly?.usedPercent ?? 0}%`} />
                </span>
                <span className={cx("text-right tabular-nums", percentColor(worst.usedPercent))}>
                  {Math.round(worst.usedPercent)}%
                </span>
                <span className="min-w-10 text-right tabular-nums text-muted-foreground">{untilReset(worst.resetsAt, now)}</span>
              </span>
            );
          })}
        </span>
      )}

      <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className={cx("size-1.5 rounded-full", account.liveThreads > 0 ? "bg-emerald-500" : "bg-muted-foreground/40")} />
        {account.liveThreads > 0
          ? `${account.liveThreads} ${plural(account.liveThreads, "тред работает", "треда работают", "тредов работают")}`
          : "сейчас без тредов"}
        <span className="opacity-60">·</span>
        {account.boundThreads} {plural(account.boundThreads, "привязан", "привязано", "привязано")}
      </span>

      {open && groups.length > 0 ? (
        <span className="flex flex-col gap-1 border-t border-dashed border-sidebar-border pt-2 text-2xs text-muted-foreground">
          {groups.flatMap((group) =>
            (
              [
                ["5ч", group.fiveHour],
                ["7д", group.weekly],
              ] as const
            ).flatMap(([span, window]) =>
              window === null
                ? []
                : [
                    <span key={`${group.name}-${span}`} className="flex justify-between gap-2">
                      <span>
                        {group.name} · {span}
                      </span>
                      <span className="tabular-nums text-sidebar-foreground">
                        {Math.round(window.usedPercent)}% · сброс через {untilReset(window.resetsAt, now)}
                      </span>
                    </span>,
                  ],
            ),
          )}
          {account.route.kind === "proxy" ? (
            <span className="flex justify-between gap-2">
              <span>Выход</span>
              <span className="tabular-nums text-sidebar-foreground">{account.route.endpoint}</span>
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

function NextLine({ pool }: { pool: Pool }) {
  if (pool.next !== null)
    return (
      <div className="flex items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1.5 text-2xs text-primary">
        <Icon name="ArrowRight" className="size-3" aria-hidden />
        Следующий тред уйдёт на <span className="font-semibold">{pool.next}</span>
      </div>
    );
  const signedIn = pool.accounts.some((account) => account.quota.status === "ok");
  return (
    <div className="rounded-md bg-warning/10 px-2 py-1.5 text-2xs text-warning">
      {signedIn ? "Все аккаунты упёрлись в лимит." : "Нет аккаунта с выполненным входом."}
    </div>
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
      <div className="flex h-9 min-w-0 shrink-0 items-center gap-1.5 border-b border-sidebar-border px-2.5">
        <Icon name={POOL_ICON} className="size-3.5 shrink-0 text-sidebar-foreground" aria-hidden />
        <span className="text-2xs font-medium text-sidebar-foreground">Пул Antigravity</span>
        {pool !== null ? (
          <span className="rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-muted-foreground">
            {pool.accounts.length}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-1 justify-end gap-0.5 overflow-x-auto">
          {machines.length > 1
            ? machines.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  onClick={() => setSelected(candidate.id)}
                  className={cx(
                    "h-6 shrink-0 rounded-md px-1.5 text-2xs",
                    candidate.id === machine?.id
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent",
                  )}
                >
                  {candidate.name}
                </button>
              ))
            : machine !== null
              ? <span className="truncate text-2xs text-muted-foreground">{machine.name}</span>
              : null}
        </span>
        <button
          type="button"
          aria-label="Обновить пул"
          onClick={() => void refresh()}
          disabled={busy}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-60"
        >
          <Icon name="RotateCw" className={cx("size-3.5", busy && "animate-spin")} aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Свернуть пул"
          onClick={dismiss}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Icon name="ChevronDown" className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto p-2.5">
        {pool === null ? (
          <div className="flex flex-col gap-2">
            {query.isLoading || busy ? (
              [0, 1].map((row) => <div key={row} className="h-24 animate-pulse rounded-lg bg-sidebar-border/50" />)
            ) : (
              <span className="text-2xs text-muted-foreground">{machine?.error ?? "Пул Antigravity не найден ни на одной машине."}</span>
            )}
          </div>
        ) : (
          <>
            <NextLine pool={pool} />
            {pool.accounts.map((account) => (
              <AccountCard key={account.name} account={account} isNext={account.name === pool.next} now={now} />
            ))}
            <span className="px-0.5 text-2xs text-muted-foreground">
              {machine?.error !== null && machine?.error !== undefined ? `${machine.error} Показаны прошлые данные. ` : ""}
              {machine?.observedAt != null ? `Обновлено ${ago(now - machine.observedAt)}` : null}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "pool",
    label: "Пул Antigravity",
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
