import { expect, test } from "bun:test";
import { parseArgs } from "node:util";
import { manifestFromFlags, options } from "./flags";
import { manifest } from "./manifest";

const fromArgs = (...args: string[]) =>
    manifest.parse(
        manifestFromFlags(
            parseArgs({ args, options, allowPositionals: true }).values,
        ),
    );

test("builds a one-Snipe Manifest with defaults", () => {
    const m = fromArgs("--target", "cax31@fsn1");
    expect(m.name).toBe("cli");
    expect(m.poll_interval).toBe(5);
    expect(m.snipes).toEqual([
        {
            name: "cax31",
            count: 1,
            target: [{ type: "cax31", location: "fsn1" }],
            server: {
                name: "{snipe}-{n}",
                image: "ubuntu-24.04",
                ssh_keys: [],
                labels: {},
                firewalls: [],
                networks: [],
                public_net: { enable_ipv4: true, enable_ipv6: true },
            },
        },
    ]);
});

test("maps every flag", () => {
    const m = fromArgs(
        "--target",
        "cax31@fsn1,cax31@nbg1",
        "--target",
        "ccx13@fsn1",
        "--name",
        "web",
        "--count",
        "2",
        "--image",
        "123",
        "--ssh-key",
        "laptop",
        "--ssh-key",
        "42",
        "--label",
        "env=prod",
        "--label",
        "team=a=b",
        "--firewall",
        "web",
        "--network",
        "7",
        "--placement-group",
        "spread",
        "--server-name",
        "node-{n}",
        "--no-ipv4",
        "--poll-interval",
        "10",
    );
    expect(m.poll_interval).toBe(10);
    expect(m.snipes[0]).toEqual({
        name: "web",
        count: 2,
        target: [
            { type: "cax31", location: "fsn1" },
            { type: "cax31", location: "nbg1" },
            { type: "ccx13", location: "fsn1" },
        ],
        server: {
            name: "node-{n}",
            image: 123,
            ssh_keys: ["laptop", 42],
            labels: { env: "prod", team: "a=b" },
            firewalls: ["web"],
            networks: [7],
            placement_group: "spread",
            public_net: { enable_ipv4: false, enable_ipv6: true },
        },
    });
});

test("invalid flag values fail the same schema checks", () => {
    const bad = (...args: string[]) =>
        manifest.safeParse(
            manifestFromFlags(
                parseArgs({ args, options, allowPositionals: true }).values,
            ),
        ).success;
    expect(bad("--target", "cax31")).toBe(false);
    expect(bad("--target", "cax31@fsn1", "--count", "two")).toBe(false);
    expect(bad("--target", "cax31@fsn1", "--server-name", "web")).toBe(false);
});
