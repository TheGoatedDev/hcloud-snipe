import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    type FakeHcloud,
    serverType,
    startFakeHcloud,
} from "../test/fake-hcloud";
import { createHcloud, type Hcloud, HcloudError } from "./hcloud";

let fake: FakeHcloud;
let hcloud: Hcloud;

const start = (perPage?: number) => {
    fake = startFakeHcloud({ perPage });
    hcloud = createHcloud({ token: fake.token, baseUrl: fake.baseUrl });
};

const serverTypeRequests = () =>
    fake.state.requests.filter((r) => r.startsWith("GET /v1/server_types"));

afterEach(() => fake.stop());

describe("serverTypes", () => {
    beforeEach(() => {
        start(2);
        fake.state.serverTypes = [
            "cx22",
            "cx32",
            "cax21",
            "cax31",
            "ccx13",
        ].map((name, i) =>
            serverType(name, { fsn1: false, nbg1: true }, i + 1),
        );
    });

    test("pages through the full list", async () => {
        const types = await hcloud.serverTypes();
        expect(types.map((t) => t.name)).toEqual([
            "cx22",
            "cx32",
            "cax21",
            "cax31",
            "ccx13",
        ]);
        expect(types[0]?.locations).toEqual([
            { name: "fsn1", available: false, deprecation: null },
            { name: "nbg1", available: true, deprecation: null },
        ]);
        expect(serverTypeRequests()).toHaveLength(3);
    });

    test("switches to ?name= once that costs fewer requests", async () => {
        // First call has to page fully to learn the page count (3).
        expect(
            (await hcloud.serverTypes(["cax31"])).map((t) => t.name),
        ).toEqual(["cax31"]);
        fake.state.requests = [];

        expect(
            (await hcloud.serverTypes(["cax31", "cax21", "cax31"])).map(
                (t) => t.name,
            ),
        ).toEqual(["cax31", "cax21"]);
        expect(serverTypeRequests().sort()).toEqual([
            "GET /v1/server_types?name=cax21&per_page=50&page=1",
            "GET /v1/server_types?name=cax31&per_page=50&page=1",
        ]);
    });

    test("keeps paging fully when ?name= would cost as much", async () => {
        await hcloud.serverTypes();
        fake.state.requests = [];

        const names = ["cx22", "cx32", "cax21"];
        expect((await hcloud.serverTypes(names)).map((t) => t.name)).toEqual(
            names,
        );
        expect(serverTypeRequests()).toHaveLength(3);
        expect(serverTypeRequests().some((r) => r.includes("name="))).toBe(
            false,
        );
    });
});

describe("servers", () => {
    beforeEach(() => {
        start();
        fake.state.serverTypes = [serverType("cax31", { fsn1: true })];
    });

    test("creates a server and lists it by label selector", async () => {
        const created = await hcloud.createServer({
            name: "web-1",
            server_type: "cax31",
            location: "fsn1",
            image: "ubuntu-24.04",
            labels: { "hcloud-snipe/snipe": "web" },
            public_net: { enable_ipv4: false, enable_ipv6: true },
        });
        expect(created).toMatchObject({
            name: "web-1",
            location: { name: "fsn1" },
            public_net: { ipv4: null },
        });

        await hcloud.createServer({
            name: "other",
            server_type: "cax31",
            location: "fsn1",
            image: "ubuntu-24.04",
        });

        expect(
            (await hcloud.servers("hcloud-snipe/snipe=web")).map((s) => s.name),
        ).toEqual(["web-1"]);
    });

    test("surfaces API errors as HcloudError", async () => {
        fake.state.createErrors.push({ status: 422, code: "placement_error" });
        const create = () =>
            hcloud.createServer({
                name: "web-1",
                server_type: "cax31",
                location: "fsn1",
                image: "ubuntu-24.04",
            });

        const error = await create().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(HcloudError);
        expect(error).toMatchObject({ status: 422, code: "placement_error" });
    });
});

describe("rate limit", () => {
    beforeEach(() => start());

    test("tracks RateLimit headers and reports 429", async () => {
        expect(hcloud.rateLimit()).toBeUndefined();
        fake.state.rateLimit = { limit: 3600, remaining: 1, reset: 1700000000 };

        await hcloud.serverTypes();
        expect(hcloud.rateLimit()).toEqual({
            limit: 3600,
            remaining: 0,
            reset: 1700000000,
        });

        await expect(hcloud.serverTypes()).rejects.toMatchObject({
            status: 429,
            code: "rate_limit_exceeded",
        });
    });

    test("rejects a bad token", async () => {
        hcloud = createHcloud({ token: "wrong", baseUrl: fake.baseUrl });
        await expect(hcloud.serverTypes()).rejects.toMatchObject({
            status: 401,
            code: "unauthorized",
        });
    });
});

describe("find", () => {
    beforeEach(() => {
        start();
        fake.state.resources.firewalls = [
            { id: 7, name: "web" },
            { id: 8, name: "db" },
        ];
    });

    test("finds by name or ID", async () => {
        expect(await hcloud.find("firewalls", "db")).toEqual([
            { id: 8, name: "db" },
        ]);
        expect(await hcloud.find("firewalls", 7)).toEqual([
            { id: 7, name: "web" },
        ]);
    });

    test("returns empty when missing", async () => {
        expect(await hcloud.find("firewalls", "nope")).toEqual([]);
        expect(await hcloud.find("firewalls", 99)).toEqual([]);
    });
});
