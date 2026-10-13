import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    type FakeHcloud,
    serverType,
    startFakeHcloud,
} from "../test/fake-hcloud";
import { createHcloud } from "./hcloud";
import { manifest as manifestSchema } from "./manifest";
import {
    type Alert,
    formatAlert,
    nextDelay,
    orderable,
    rateLimitedDelay,
    run,
} from "./run";

const manifest = manifestSchema.parse({
    name: "lab",
    snipes: [
        {
            name: "web",
            target: ["cax31@fsn1", "cax31@nbg1"],
            server: { image: "ubuntu-24.04" },
        },
        {
            name: "db",
            target: ["ccx13@fsn1"],
            server: { image: "ubuntu-24.04" },
        },
    ],
});

let fake: FakeHcloud;
beforeEach(() => {
    fake = startFakeHcloud();
});
afterEach(() => fake.stop());

/** Runs one poll per entry in `ticks`; each entry sets stock before that poll. */
async function runTicks(ticks: (() => void)[], token = fake.token) {
    const alerts: Alert[] = [];
    const delays: number[] = [];
    const logs: string[] = [];
    const controller = new AbortController();
    let tick = 0;
    ticks[0]?.();
    const code = await run({
        manifest,
        hcloud: createHcloud({ token, baseUrl: fake.baseUrl }),
        alert: (a) => {
            alerts.push(a);
        },
        log: (m) => logs.push(m),
        sleep: async (ms) => {
            delays.push(ms);
            tick++;
            if (tick >= ticks.length) controller.abort();
            else ticks[tick]?.();
        },
        signal: controller.signal,
    });
    return {
        code,
        alerts,
        delays,
        logs,
        sightings: alerts.map((a) => a.kind === "sighting" && formatAlert(a)),
    };
}

const stock =
    (
        cax31: Record<string, boolean>,
        ccx13: Record<string, boolean> = { fsn1: false },
    ) =>
    () => {
        fake.state.serverTypes = [
            serverType("cax31", cax31, 1),
            serverType("ccx13", ccx13, 2),
        ];
    };

describe("run", () => {
    test("alerts only when a Candidate becomes orderable", async () => {
        const { code, sightings, delays } = await runTicks([
            stock({ fsn1: false, nbg1: false }),
            stock({ fsn1: true, nbg1: false }),
            stock({ fsn1: true, nbg1: true }),
            stock({ fsn1: true, nbg1: true }),
            stock({ fsn1: false, nbg1: true }),
            stock({ fsn1: true, nbg1: true }),
        ]);
        expect(code).toBe(0);
        expect(sightings).toEqual([
            "[lab] Sighting: cax31@fsn1 is orderable (snipe web)",
            "[lab] Sighting: cax31@nbg1 is orderable (snipe web)",
            "[lab] Sighting: cax31@fsn1 is orderable (snipe web)",
        ]);
        expect(delays).toEqual(Array(6).fill(5000));
    });

    test("alerts on the first poll for stock that is already orderable", async () => {
        const { sightings } = await runTicks([
            stock({ fsn1: false, nbg1: false }, { fsn1: true }),
        ]);
        expect(sightings).toEqual([
            "[lab] Sighting: ccx13@fsn1 is orderable (snipe db)",
        ]);
    });

    test("ignores stock outside the Manifest", async () => {
        const { sightings } = await runTicks([
            () => {
                stock({ fsn1: false, nbg1: false })();
                fake.state.serverTypes.push(
                    serverType("cx22", { fsn1: true }, 3),
                );
                fake.state.serverTypes.push(
                    serverType("cax31-x", { fsn1: true }, 4),
                );
            },
        ]);
        expect(sightings).toEqual([]);
    });

    test("exits with a fatal Alert on a bad token", async () => {
        const { code, alerts } = await runTicks(
            [stock({ fsn1: true })],
            "wrong",
        );
        expect(code).toBe(1);
        expect(alerts).toEqual([
            {
                kind: "fatal",
                manifest: "lab",
                error: "unauthorized: unauthorized",
            },
        ]);
    });

    test("backs off when rate limited and keeps polling", async () => {
        const { code, delays, logs, sightings } = await runTicks([
            () => {
                stock({ fsn1: true })();
                fake.state.rateLimit = { limit: 3600, remaining: 0, reset: 0 };
            },
            () => {
                fake.state.rateLimit.remaining = 3600;
            },
        ]);
        expect(code).toBe(0);
        expect(delays).toEqual([5000, 5000]);
        expect(logs).toEqual(["rate limited, next poll in 5s"]);
        expect(sightings).toEqual([
            "[lab] Sighting: cax31@fsn1 is orderable (snipe web)",
        ]);
    });

    test("keeps polling through network errors", async () => {
        fake.stop();
        const { code, logs } = await runTicks([
            stock({ fsn1: true }),
            () => {},
        ]);
        expect(code).toBe(0);
        expect(logs).toHaveLength(2);
        expect(logs[0]).toStartWith("poll failed:");
    });
});

describe("orderable", () => {
    test("excludes out-of-stock and retired locations", () => {
        const type = serverType("cax31", {
            fsn1: true,
            nbg1: false,
            hel1: true,
        });
        const hel1 = type.locations[2];
        if (hel1)
            hel1.deprecation = { unavailable_after: "2026-01-01T00:00:00Z" };
        expect([
            ...orderable([type], Date.parse("2026-06-01T00:00:00Z")),
        ]).toEqual(["cax31@fsn1"]);
        expect([
            ...orderable([type], Date.parse("2025-06-01T00:00:00Z")),
        ]).toEqual(["cax31@fsn1", "cax31@hel1"]);
    });
});

describe("delays", () => {
    const limit = 3600;

    test("slows to 30s when under 20% of the budget is left", () => {
        expect(nextDelay(5000, undefined)).toBe(5000);
        expect(nextDelay(5000, { limit, remaining: 720, reset: 0 })).toBe(5000);
        expect(nextDelay(5000, { limit, remaining: 719, reset: 0 })).toBe(
            30_000,
        );
        expect(nextDelay(60_000, { limit, remaining: 0, reset: 0 })).toBe(
            60_000,
        );
    });

    test("waits for reset after a 429, capped at a minute", () => {
        const now = 1_000_000_000_000;
        const reset = (s: number) => ({
            limit,
            remaining: 0,
            reset: now / 1000 + s,
        });
        expect(rateLimitedDelay(5000, reset(20), now)).toBe(20_000);
        expect(rateLimitedDelay(5000, reset(3600), now)).toBe(60_000);
        expect(rateLimitedDelay(5000, reset(-5), now)).toBe(5000);
        expect(rateLimitedDelay(5000, undefined, now)).toBe(60_000);
    });
});
