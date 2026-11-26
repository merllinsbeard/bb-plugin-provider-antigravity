import { describe, expect, it } from "vitest";
import type { AccountName } from "../src/pool/account.ts";
import { pickAccount, type Candidate } from "../src/pool/pick.ts";
import type { ProviderQuota } from "../src/usage/types.ts";

const now = new Date("2026-11-26T12:00:00Z");
const inHours = (hours: number) => new Date(now.getTime() + hours * 3600_000).toISOString();

type Room = { readonly weekly: number; readonly fiveHour: number };

/** agy's live quota shape: a 5h and a weekly window per metered group, weekly resets six days out. */
function quota(groups: { gemini?: Room; "3p"?: Room }): ProviderQuota {
  return {
    groups: Object.entries(groups).map(([family, room]) => ({
      name: family === "gemini" ? "Gemini Models" : "Claude and GPT models",
      buckets: [
        { bucketId: `${family}-weekly`, name: "weekly", window: "weekly", remainingFraction: room!.weekly, resetsAtIso: inHours(144) },
        { bucketId: `${family}-5h`, name: "5h", window: "5h", remainingFraction: room!.fiveHour, resetsAtIso: inHours(3) },
      ],
    })),
  };
}

const account = (name: string, gemini: Room, liveThreads: number, threeP?: Room): Candidate => ({
  name: name as AccountName,
  quota: quota(threeP ? { gemini, "3p": threeP } : { gemini }),
  liveThreads,
});

const picked = (candidates: Candidate[], family: "gemini" | null = "gemini") => {
  const pick = pickAccount(candidates, family, now);
  return pick.ok ? pick.account : pick;
};

describe("pickAccount under a burst of parallel threads", () => {
  const draining = { weekly: 0.9, fiveHour: 0.6 };
  const fresh = { weekly: 0.95, fiveHour: 1 };

  it("keeps draining the active 5h window while one thread runs there with room left", () => {
    expect(picked([account("acc1", draining, 0), account("acc2", fresh, 0)])).toBe("acc1");
    expect(picked([account("acc1", draining, 1), account("acc2", fresh, 0)])).toBe("acc1");
  });

  it("sends the third thread to an idle account once two already run on the active 5h window", () => {
    expect(picked([account("acc1", draining, 2), account("acc2", fresh, 0)])).toBe("acc2");
  });

  it("sends the second thread away from an account with under 25% of its 5h window left", () => {
    const nearlyEmpty = { weekly: 0.9, fiveHour: 0.2 };
    expect(picked([account("acc1", nearlyEmpty, 0), account("acc2", fresh, 0)])).toBe("acc1");
    expect(picked([account("acc1", nearlyEmpty, 1), account("acc2", fresh, 0)])).toBe("acc2");
  });

  it("spreads threads by fewest live threads when every account in the band is busy", () => {
    const pool = [
      account("acc1", { weekly: 0.9, fiveHour: 0.1 }, 3),
      account("acc2", { weekly: 0.92, fiveHour: 0.5 }, 2),
      account("acc3", { weekly: 0.95, fiveHour: 0.8 }, 2),
      account("acc5", { weekly: 0.85, fiveHour: 0.2 }, 1),
    ];
    expect(picked(pool)).toBe("acc5");
  });

  it("places nine threads started one after another across four accounts without stacking more than three on one", () => {
    const rooms: Record<string, Room> = {
      default: { weekly: 0.9, fiveHour: 0.5 },
      acc2: { weekly: 0.95, fiveHour: 1 },
      acc3: { weekly: 0.88, fiveHour: 0.7 },
      acc5: { weekly: 1, fiveHour: 1 },
    };
    const live: Record<string, number> = { default: 0, acc2: 0, acc3: 0, acc5: 0 };
    for (let i = 0; i < 9; i++) {
      const choice = picked(Object.keys(rooms).map((name) => account(name, rooms[name]!, live[name]!)));
      live[choice as string]! += 1;
    }
    expect(Math.max(...Object.values(live))).toBeLessThanOrEqual(3);
    expect(Object.values(live).every((count) => count >= 2)).toBe(true);
  });
});

describe("pickAccount before the model is known", () => {
  it("judges an account by its Gemini room, not a nearly spent Claude/GPT group", () => {
    // 26.11 live state: default has Gemini 89% but Claude/GPT 38%; acc5 has less Gemini.
    const pool = [
      account("default", { weekly: 0.89, fiveHour: 0.89 }, 0, { weekly: 0.38, fiveHour: 0.38 }),
      account("acc5", { weekly: 0.7, fiveHour: 1 }, 0, { weekly: 1, fiveHour: 1 }),
    ];
    expect(picked(pool, null)).toBe("default");
  });

  it("still starts a thread on an account whose Gemini room is gone but Claude/GPT has some", () => {
    const pool = [account("acc3", { weekly: 0.5, fiveHour: 0 }, 0, { weekly: 0.6, fiveHour: 0.6 })];
    expect(picked(pool, null)).toBe("acc3");
  });

  it("falls back to every metered group for an account without a Gemini group", () => {
    const claudeOnly: Candidate = { name: "acc9" as AccountName, quota: quota({ "3p": { weekly: 0.9, fiveHour: 0.9 } }), liveThreads: 0 };
    const geminiLow = account("acc2", { weekly: 0.3, fiveHour: 0.3 }, 0);
    expect(picked([geminiLow, claudeOnly], null)).toBe("acc9");
  });
});
