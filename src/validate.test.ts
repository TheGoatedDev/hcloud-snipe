import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    type FakeHcloud,
    serverType,
    startFakeHcloud,
} from "../test/fake-hcloud";
import { createHcloud } from "./hcloud";
import { manifest } from "./manifest";
import { validate } from "./validate";

let fake: FakeHcloud;
beforeEach(() => {
    fake = startFakeHcloud();
    fake.state.serverTypes = [
        serverType("cax31", { fsn1: false, nbg1: true }, 1),
        serverType("cx22", { fsn1: true, ash: true }, 2),
    ];
});
afterEach(() => fake.stop());

const check = (snipe: Record<string, unknown>) =>
    validate(
        createHcloud({ token: fake.token, baseUrl: fake.baseUrl }),
        manifest.parse({
            name: "lab",
            snipes: [{ name: "web", target: ["cax31@fsn1"], ...snipe }],
        }),
        Date.parse("2026-10-01T00:00:00Z"),
    );

const problems = async (snipe: Record<string, unknown>) => {
    const error = await check(snipe).catch((e: unknown) => e);
    if (!(error instanceof Error)) return [];
    return error.message.split("\n  - ").slice(1);
};

test("accepts a valid Snipe and resolves IDs", async () => {
    fake.state.resources.networks = [
        { id: 9, name: "net-eu", subnets: [{ network_zone: "eu-central" }] },
    ];
    const resolved = await check({
        target: ["cax31@fsn1", "cx22@fsn1"],
        server: { image: "ubuntu-24.04", networks: ["net-eu"] },
    });
    expect([...resolved.values()]).toEqual([{ firewalls: [], networks: [9] }]);
});

test("lists every problem at once", async () => {
    const type = fake.state.serverTypes[1];
    const ash = type?.locations[1];
    if (ash) ash.deprecation = { unavailable_after: "2026-09-01T00:00:00Z" };
    fake.state.resources.networks = [
        { id: 9, name: "net-eu", subnets: [{ network_zone: "eu-central" }] },
    ];

    expect(
        await problems({
            target: ["cax99@fsn1", "cax31@hel1", "cx22@ash"],
            server: {
                image: "ubuntu-24.04",
                ssh_keys: ["laptop"],
                firewalls: [7],
                networks: ["net-eu"],
                placement_group: "spread",
            },
        }),
    ).toEqual([
        "snipe web: unknown server type cax99",
        "snipe web: cax31@hel1 is not offered (cax31 is sold in fsn1, nbg1)",
        "snipe web: cx22@ash has been retired",
        "snipe web: ssh key laptop not found",
        "snipe web: firewall 7 not found",
        'snipe web: placement group "spread" not found',
        'snipe web: cx22@ash is in us-east, outside network "net-eu" (eu-central)',
    ]);
});

test("checks the image exists for every architecture in the Target", async () => {
    fake.state.resources.images = [
        { id: 1001, name: "debian-13", architecture: "x86" },
        { id: 2001, name: "snap", architecture: "arm" },
    ];
    expect(
        await problems({
            target: ["cax31@fsn1", "cx22@fsn1"],
            server: { image: "debian-13" },
        }),
    ).toEqual(["snipe web: image debian-13 not found for arm"]);
    expect(
        await problems({
            target: ["cax31@fsn1", "cx22@fsn1"],
            server: { image: 2001 },
        }),
    ).toEqual(["snipe web: image 2001 not found for x86"]);
});
