import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type FakeHcloud,
    serverType,
    startFakeHcloud,
} from "../test/fake-hcloud";
import { nextName } from "./claim";
import { createHcloud } from "./hcloud";
import { type Manifest, manifest as manifestSchema } from "./manifest";
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
async function runTicks(
    ticks: (() => void)[],
    {
        token = fake.token,
        dryRun = true,
        m = manifest,
    }: { token?: string; dryRun?: boolean; m?: Manifest } = {},
) {
    const alerts: Alert[] = [];
    const delays: number[] = [];
    const logs: string[] = [];
    const controller = new AbortController();
    let tick = 0;
    ticks[0]?.();
    const code = await run({
        manifest: m,
        dryRun,
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
        sightings: alerts.filter((a) => a.kind === "sighting").map(formatAlert),
        formatted: alerts.map(formatAlert),
    };
}

const stock =
    (
        cax31: Record<string, boolean>,
        ccx13: Record<string, boolean> = { fsn1: false },
    ) =>
    () => {
        fake.state.serverTypes = [
            serverType("cax31", { fsn1: false, nbg1: false, ...cax31 }, 1),
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
        const { code, alerts } = await runTicks([stock({ fsn1: true })], {
            token: "wrong",
        });
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

describe("claiming", () => {
    const snipe = (overrides: Record<string, unknown> = {}) => ({
        name: "web",
        target: ["cax31@fsn1", "cax31@nbg1"],
        server: { image: "ubuntu-24.04" },
        ...overrides,
    });
    const lab = (...snipes: Record<string, unknown>[]) =>
        manifestSchema.parse({ name: "lab", snipes });
    const labels = (snipeName: string) => ({
        "hcloud-snipe/manifest": "lab",
        "hcloud-snipe/snipe": snipeName,
    });
    const existing = (name: string, serverLabels: Record<string, string>) => {
        fake.state.servers.push({
            id: fake.state.nextId++,
            name,
            labels: serverLabels,
            server_type: { name: "cax31" },
            location: { name: "fsn1" },
            public_net: { ipv4: null, ipv6: null },
        });
    };
    const posts = () => fake.state.requests.filter((r) => r.startsWith("POST"));

    test("claims the best Sighted Candidate and exits Fulfilled", async () => {
        fake.state.resources.ssh_keys = [
            { id: 41, name: "laptop" },
            { id: 42, name: "desktop" },
        ];
        const m = lab(
            snipe({
                server: {
                    image: "ubuntu-24.04",
                    ssh_keys: ["laptop", 42],
                    labels: { env: "prod" },
                    public_net: { enable_ipv4: false },
                },
            }),
        );
        const { code, formatted } = await runTicks(
            [
                stock({ fsn1: false, nbg1: false }),
                stock({ fsn1: true, nbg1: true }),
                () => {},
            ],
            { dryRun: false, m },
        );
        expect(code).toBe(0);
        expect(formatted).toEqual([
            "[lab] Claim: web-1 on cax31@fsn1 (snipe web) 2001:db8:1::/64",
            "[lab] Snipe web Fulfilled",
            "[lab] Manifest Fulfilled",
        ]);
        expect(fake.state.created).toEqual([
            {
                name: "web-1",
                server_type: "cax31",
                location: "fsn1",
                image: "ubuntu-24.04",
                ssh_keys: ["laptop", "42"],
                labels: { env: "prod", ...labels("web") },
                firewalls: [],
                networks: [],
                public_net: { enable_ipv4: false, enable_ipv6: true },
            },
        ]);
    });

    test("moves to the next Candidate after a lost race", async () => {
        fake.state.createErrors.push({
            status: 412,
            code: "resource_unavailable",
        });
        const { code, formatted, logs } = await runTicks(
            [stock({ fsn1: true, nbg1: true })],
            { dryRun: false, m: lab(snipe()) },
        );
        expect(code).toBe(0);
        expect(formatted[0]).toStartWith("[lab] Claim: web-1 on cax31@nbg1");
        expect(logs).toEqual([
            "lost race for cax31@fsn1 (snipe web): resource_unavailable",
        ]);
    });

    test("waits for the next poll when every Sighted Candidate is lost", async () => {
        fake.state.createErrors.push({ status: 422, code: "placement_error" });
        const { code, formatted } = await runTicks(
            [stock({ fsn1: true, nbg1: false }), () => {}],
            { dryRun: false, m: lab(snipe()) },
        );
        expect(code).toBe(0);
        expect(posts()).toHaveLength(2);
        expect(formatted[0]).toStartWith("[lab] Claim: web-1 on cax31@fsn1");
    });

    test("claims up to count in one poll", async () => {
        const { formatted } = await runTicks(
            [stock({ fsn1: true, nbg1: true })],
            { dryRun: false, m: lab(snipe({ count: 2 })) },
        );
        expect(formatted.slice(0, 2)).toEqual([
            "[lab] Claim: web-1 on cax31@fsn1 (snipe web) 198.51.100.1, 2001:db8:1::/64",
            "[lab] Claim: web-2 on cax31@fsn1 (snipe web) 198.51.100.2, 2001:db8:2::/64",
        ]);
        expect(posts()).toHaveLength(2);
    });

    test("exits quietly when already Fulfilled at startup", async () => {
        existing("web-1", labels("web"));
        const { code, alerts, logs } = await runTicks([stock({ fsn1: true })], {
            dryRun: false,
            m: lab(snipe()),
        });
        expect(code).toBe(0);
        expect(alerts).toEqual([]);
        expect(logs).toEqual(["[lab] already Fulfilled"]);
        expect(posts()).toEqual([]);
    });

    test("counts earlier Claims and skips their names", async () => {
        existing("web-1", labels("web"));
        existing("web-2", labels("other")); // unlabelled for this Snipe
        const { formatted } = await runTicks([stock({ fsn1: true })], {
            dryRun: false,
            m: lab(snipe({ count: 2 })),
        });
        expect(formatted[0]).toStartWith("[lab] Claim: web-3 on cax31@fsn1");
        expect(posts()).toHaveLength(2); // web-2 hit uniqueness_error first
    });

    test("does not count servers from another Manifest", async () => {
        existing("web-1", {
            ...labels("web"),
            "hcloud-snipe/manifest": "prod",
        });
        const { formatted } = await runTicks([stock({ fsn1: true })], {
            dryRun: false,
            m: lab(snipe()),
        });
        expect(formatted[0]).toStartWith("[lab] Claim: web-2");
    });

    test("waits for every Snipe before the Manifest is Fulfilled", async () => {
        const m = lab(snipe(), snipe({ name: "db", target: ["ccx13@fsn1"] }));
        const { code, formatted } = await runTicks(
            [
                stock({ fsn1: true }),
                stock({ fsn1: false }, { fsn1: true }),
                () => {},
            ],
            { dryRun: false, m },
        );
        expect(code).toBe(0);
        expect(formatted.map((f) => f.split(" (")[0])).toEqual([
            "[lab] Claim: web-1 on cax31@fsn1",
            "[lab] Snipe web Fulfilled",
            "[lab] Claim: db-1 on ccx13@fsn1",
            "[lab] Snipe db Fulfilled",
            "[lab] Manifest Fulfilled",
        ]);
    });

    test("stops with a fatal Alert when the project quota is hit", async () => {
        fake.state.createErrors.push({
            status: 403,
            code: "resource_limit_exceeded",
        });
        const { code, formatted } = await runTicks(
            [stock({ fsn1: true }), () => {}],
            { dryRun: false, m: lab(snipe()) },
        );
        expect(code).toBe(1);
        expect(formatted).toEqual([
            "[lab] Fatal: creating web-1: resource_limit_exceeded: resource_limit_exceeded",
        ]);
        expect(fake.state.created).toEqual([]);
    });

    test("retries on the next poll after a server error", async () => {
        fake.state.createErrors.push({ status: 503, code: "unavailable" });
        const { code, formatted, logs } = await runTicks(
            [stock({ fsn1: true, nbg1: true }), () => {}],
            { dryRun: false, m: lab(snipe()) },
        );
        expect(code).toBe(0);
        expect(logs).toEqual(["poll failed: unavailable: unavailable"]);
        expect(formatted[0]).toStartWith("[lab] Claim: web-1 on cax31@fsn1");
        expect(fake.state.created).toHaveLength(1);
    });

    test("resolves resource names and reads user_data_file", async () => {
        fake.state.resources.firewalls = [
            { id: 7, name: "web" },
            { id: 8, name: "ssh" },
        ];
        fake.state.resources.networks = [
            {
                id: 9,
                name: "net-eu",
                subnets: [{ network_zone: "eu-central" }],
            },
        ];
        fake.state.resources.placement_groups = [{ id: 3, name: "spread" }];
        const userData = join(
            await mkdtemp(join(tmpdir(), "hcloud-snipe-")),
            "init.yaml",
        );
        await writeFile(userData, "#cloud-config\n");
        const m = lab(
            snipe({
                server: {
                    image: "ubuntu-24.04",
                    firewalls: ["web", 8],
                    networks: ["net-eu"],
                    placement_group: "spread",
                    user_data_file: userData,
                },
            }),
        );
        await runTicks([stock({ fsn1: true })], { dryRun: false, m });
        expect(fake.state.created[0]).toMatchObject({
            firewalls: [{ firewall: 7 }, { firewall: 8 }],
            networks: [9],
            placement_group: 3,
            user_data: "#cloud-config\n",
        });
    });

    test("fails at startup when a named resource is missing", async () => {
        const m = lab(
            snipe({ server: { image: "ubuntu-24.04", firewalls: ["nope"] } }),
        );
        const { code, formatted } = await runTicks([stock({ fsn1: true })], {
            dryRun: false,
            m,
        });
        expect(code).toBe(1);
        expect(formatted).toEqual([
            '[lab] Fatal: invalid Manifest lab:\n  - snipe web: firewall "nope" not found',
        ]);
        expect(posts()).toEqual([]);
    });

    test("never creates in a Dry run", async () => {
        const { sightings } = await runTicks([stock({ fsn1: true })], {
            m: lab(snipe()),
        });
        expect(sightings).toHaveLength(1);
        expect(posts()).toEqual([]);
    });
});

test("nextName picks the lowest free index", () => {
    const s = manifestSchema.parse({
        name: "lab",
        snipes: [
            {
                name: "web",
                target: ["cax31@fsn1"],
                server: { image: "x", name: "{snipe}{n}.lab" },
            },
        ],
    }).snipes[0];
    if (!s) throw new Error("unreachable");
    expect(nextName(s, new Set())).toBe("web1.lab");
    expect(nextName(s, new Set(["web1.lab", "web3.lab"]))).toBe("web2.lab");
});
