// Keeps ACP `available_commands_update` payloads under BB's 65,536-byte
// `extension.state` limit (`bb/provider-commands`), so BB does not drop the
// whole command list into `provider/unhandled` when an agent advertises
// hundreds of skills alongside its built-in slash commands.

export const MAX_PROVIDER_COMMANDS_BYTES = 60_000;
const MAX_PROVIDER_COMMANDS_COUNT = 500;

export type RawAvailableCommand = {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly input?: { readonly hint?: unknown } | null;
  readonly [key: string]: unknown;
};

type SessionUpdateMessage = {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly [key: string]: unknown;
};

function toBbStateCommands(commands: readonly RawAvailableCommand[]) {
  const out: Array<{ name: string; description: string; inputHint?: string }> = [];
  for (const cmd of commands) {
    if (out.length >= MAX_PROVIDER_COMMANDS_COUNT) break;
    if (typeof cmd?.name !== "string" || cmd.name.trim() === "") continue;
    const description = typeof cmd.description === "string" ? cmd.description : "";
    const hint = cmd.input && typeof cmd.input === "object" && typeof cmd.input.hint === "string" ? cmd.input.hint : undefined;
    out.push(hint !== undefined && hint !== "" ? { name: cmd.name, description, inputHint: hint } : { name: cmd.name, description });
  }
  return { commands: out };
}

export function providerCommandsPayloadBytes(commands: readonly RawAvailableCommand[]): number {
  return Buffer.byteLength(JSON.stringify(toBbStateCommands(commands)), "utf8");
}

function truncateDescription(description: string, maxChars: number): string {
  if (description.length <= maxChars) return description;
  if (maxChars <= 1) return "";
  return `${description.slice(0, maxChars - 1).trimEnd()}…`;
}

function withMaxDescriptionChars(commands: readonly RawAvailableCommand[], maxChars: number): RawAvailableCommand[] {
  return commands.map((cmd) => {
    if (typeof cmd?.description !== "string" || cmd.description.length <= maxChars) return cmd;
    return { ...cmd, description: truncateDescription(cmd.description, maxChars) };
  });
}

export function fitAvailableCommands(
  commands: readonly RawAvailableCommand[],
  maxBytes: number = MAX_PROVIDER_COMMANDS_BYTES,
): readonly RawAvailableCommand[] {
  if (providerCommandsPayloadBytes(commands) <= maxBytes) return commands;

  const maxLen = commands.reduce(
    (best, cmd) => (typeof cmd?.description === "string" && cmd.description.length > best ? cmd.description.length : best),
    0,
  );

  // Binary-search the longest description cap that keeps every command inside the byte budget.
  let lo = 0;
  let hi = maxLen;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (providerCommandsPayloadBytes(withMaxDescriptionChars(commands, mid)) <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best >= 0) return withMaxDescriptionChars(commands, best);

  // Even empty descriptions exceed the budget: keep the largest prefix that fits.
  const stripped = withMaxDescriptionChars(commands, 0);
  let lowCount = 0;
  let highCount = stripped.length;
  let bestCount = 0;
  while (lowCount <= highCount) {
    const mid = (lowCount + highCount) >>> 1;
    if (providerCommandsPayloadBytes(stripped.slice(0, mid)) <= maxBytes) {
      bestCount = mid;
      lowCount = mid + 1;
    } else {
      highCount = mid - 1;
    }
  }
  return stripped.slice(0, bestCount);
}

export function fitAvailableCommandsLine(
  line: string,
  message: SessionUpdateMessage,
  maxBytes: number = MAX_PROVIDER_COMMANDS_BYTES,
): string {
  if (message.method !== "session/update") return line;
  const update = message.params?.update;
  if (update === null || typeof update !== "object" || Array.isArray(update)) return line;
  const record = update as Record<string, unknown>;
  if (record.sessionUpdate !== "available_commands_update" || !Array.isArray(record.availableCommands)) return line;
  const raw = record.availableCommands as RawAvailableCommand[];
  const fitted = fitAvailableCommands(raw, maxBytes);
  if (fitted === raw) return line;
  return JSON.stringify({
    ...message,
    params: {
      ...message.params,
      update: {
        ...record,
        availableCommands: fitted,
      },
    },
  });
}
