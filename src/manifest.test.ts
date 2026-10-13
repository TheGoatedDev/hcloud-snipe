import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestJsonSchema } from "../scripts/schema";
import { loadManifest, manifest } from "./manifest";

const minimal = {
    name: "lab",
    snipes: [
        {
            name: "web",
            target: ["cax31@fsn1", "cax31@nbg1"],
            server: { image: "ubuntu-24.04" },
        },
    ],
};

const withSnipe = (overrides: Record<string, unknown>) => ({
    ...minimal,
    snipes: [{ ...minimal.snipes[0], ...overrides }],
});

const withServer = (overrides: Record<string, unknown>) =>
    withSnipe({ server: { image: "ubuntu-24.04", ...overrides } });

describe("manifest", () => {
    test("fills defaults and parses Candidates", () => {
        const m = manifest.parse(minimal);
        expect(m.poll_interval).toBe(5);
        const [web] = m.snipes;
        expect(web?.count).toBe(1);
        expect(web?.target).toEqual([
            { type: "cax31", location: "fsn1" },
            { type: "cax31", location: "nbg1" },
        ]);
        expect(web?.server).toEqual({
            name: "{snipe}-{n}",
            image: "ubuntu-24.04",
            ssh_keys: [],
            labels: {},
            firewalls: [],
            networks: [],
            public_net: { enable_ipv4: true, enable_ipv6: true },
        });
    });

    test.each([
        ["malformed Candidate", withSnipe({ target: ["cax31-fsn1"] })],
        ["empty target", withSnipe({ target: [] })],
        [
            "duplicate Candidate",
            withSnipe({ target: ["cax31@fsn1", "cax31@fsn1"] }),
        ],
        ["count below 1", withSnipe({ count: 0 })],
        ["invalid snipe name", withSnipe({ name: "Web_1" })],
        ["name template without {n}", withServer({ name: "web" })],
        [
            "reserved label key",
            withServer({ labels: { "hcloud-snipe/snipe": "x" } }),
        ],
        ["unknown server key", withServer({ sshkeys: ["laptop"] })],
        ["poll_interval below 1s", { ...minimal, poll_interval: 0.5 }],
        [
            "duplicate snipe names",
            { ...minimal, snipes: [minimal.snipes[0], minimal.snipes[0]] },
        ],
        ["no snipes", { ...minimal, snipes: [] }],
    ])("rejects %s", (_, input) => {
        expect(manifest.safeParse(input).success).toBe(false);
    });
});

describe("loadManifest", () => {
    const yaml = (userData: string) => `
name: lab
snipes:
  - name: web
    target: [cax31@fsn1]
    server:
      image: ubuntu-24.04
      user_data_file: ${userData}
`;

    test("resolves user_data_file relative to the Manifest", async () => {
        const dir = await mkdtemp(join(tmpdir(), "hcloud-snipe-"));
        await writeFile(join(dir, "init.yaml"), "#cloud-config\n");
        await writeFile(join(dir, "manifest.yaml"), yaml("./init.yaml"));

        const m = await loadManifest(join(dir, "manifest.yaml"));
        expect(m.snipes[0]?.server.user_data_file).toBe(join(dir, "init.yaml"));
    });

    test("fails when user_data_file is missing", async () => {
        const dir = await mkdtemp(join(tmpdir(), "hcloud-snipe-"));
        await writeFile(join(dir, "manifest.yaml"), yaml("./nope.yaml"));

        await expect(loadManifest(join(dir, "manifest.yaml"))).rejects.toThrow(
            "user_data_file not found",
        );
    });
});

test("manifest.schema.json is up to date (run `bun run schema`)", async () => {
    expect(await Bun.file("manifest.schema.json").text()).toBe(
        manifestJsonSchema(),
    );
});
