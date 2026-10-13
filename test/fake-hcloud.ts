// In-process fake of the Hetzner Cloud API endpoints hcloud-snipe uses.
import type { CreateServerBody, Server, ServerType } from "../src/hcloud";

type Resource =
    | "images"
    | "ssh_keys"
    | "firewalls"
    | "networks"
    | "placement_groups";

export type FakeHcloud = ReturnType<typeof startFakeHcloud>;

const err = (status: number, code: string, message = code) =>
    Response.json({ error: { code, message } }, { status });

export function startFakeHcloud({ perPage = 50 }: { perPage?: number } = {}) {
    const state = {
        serverTypes: [] as ServerType[],
        servers: [] as Server[],
        resources: {
            images: [],
            ssh_keys: [],
            firewalls: [],
            networks: [],
            placement_groups: [],
        } as Record<
            Resource,
            { id: number; name: string; [k: string]: unknown }[]
        >,
        /** Errors returned by the next POST /servers calls, in order. */
        createErrors: [] as { status: number; code: string }[],
        rateLimit: { limit: 3600, remaining: 3600, reset: 0 },
        /** `METHOD /path?query` of every request received. */
        requests: [] as string[],
        nextId: 1,
    };

    const page = (key: string, items: unknown[], url: URL) => {
        const size = Math.min(
            Number(url.searchParams.get("per_page") ?? 25),
            perPage,
        );
        const n = Number(url.searchParams.get("page") ?? 1);
        const last = Math.max(1, Math.ceil(items.length / size));
        return Response.json({
            [key]: items.slice((n - 1) * size, n * size),
            meta: {
                pagination: {
                    page: n,
                    per_page: size,
                    next_page: n < last ? n + 1 : null,
                    last_page: last,
                },
            },
        });
    };

    const matchesSelector = (
        labels: Record<string, string>,
        selector: string | null,
    ) =>
        (selector ?? "")
            .split(",")
            .filter(Boolean)
            .every((pair) => {
                const [k, v] = pair.split("=");
                return k !== undefined && labels[k] === v;
            });

    function createServer(body: CreateServerBody): Response {
        const failure = state.createErrors.shift();
        if (failure) return err(failure.status, failure.code);
        if (state.servers.some((s) => s.name === body.name))
            return err(409, "uniqueness_error");
        const type = state.serverTypes.find((t) => t.name === body.server_type);
        if (!type)
            return err(
                400,
                "invalid_input",
                `unknown server_type ${body.server_type}`,
            );
        const loc = type.locations.find((l) => l.name === body.location);
        if (!loc?.available) return err(412, "resource_unavailable");
        const id = state.nextId++;
        const server: Server = {
            id,
            name: body.name,
            labels: body.labels ?? {},
            server_type: { name: type.name },
            location: { name: body.location },
            public_net: {
                ipv4:
                    body.public_net?.enable_ipv4 === false
                        ? null
                        : { ip: `198.51.100.${id}` },
                ipv6:
                    body.public_net?.enable_ipv6 === false
                        ? null
                        : { ip: `2001:db8:${id}::/64` },
            },
        };
        state.servers.push(server);
        return Response.json({ server }, { status: 201 });
    }

    async function handle(req: Request): Promise<Response> {
        const url = new URL(req.url);
        state.requests.push(`${req.method} ${url.pathname}${url.search}`);
        if (req.headers.get("Authorization") !== "Bearer test-token")
            return err(401, "unauthorized");
        if (state.rateLimit.remaining <= 0)
            return err(429, "rate_limit_exceeded");
        state.rateLimit.remaining--;

        const path = url.pathname.replace(/^\/v1/, "");
        const name = url.searchParams.get("name");

        if (path === "/server_types" && req.method === "GET") {
            return page(
                "server_types",
                state.serverTypes.filter(
                    (t) => name === null || t.name === name,
                ),
                url,
            );
        }
        if (path === "/servers" && req.method === "GET") {
            const selector = url.searchParams.get("label_selector");
            return page(
                "servers",
                state.servers.filter((s) =>
                    matchesSelector(s.labels, selector),
                ),
                url,
            );
        }
        if (path === "/servers" && req.method === "POST") {
            return createServer((await req.json()) as CreateServerBody);
        }
        const [, resource, id] = path.split("/") as [
            string,
            Resource,
            string | undefined,
        ];
        if (resource in state.resources && req.method === "GET") {
            const all = state.resources[resource];
            if (id !== undefined) {
                const found = all.find((r) => r.id === Number(id));
                return found
                    ? Response.json({ [resource.replace(/s$/, "")]: found })
                    : err(404, "not_found");
            }
            return page(
                resource,
                all.filter((r) => name === null || r.name === name),
                url,
            );
        }
        return err(404, "not_found");
    }

    const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
            const res = await handle(req);
            const { limit, remaining, reset } = state.rateLimit;
            res.headers.set("RateLimit-Limit", String(limit));
            res.headers.set(
                "RateLimit-Remaining",
                String(Math.max(0, remaining)),
            );
            res.headers.set("RateLimit-Reset", String(reset));
            return res;
        },
    });

    return {
        state,
        baseUrl: `${server.url.origin}/v1`,
        token: "test-token",
        stop: () => server.stop(true),
    };
}

/** A server type sold in the given locations; `true` means currently orderable. */
export function serverType(
    name: string,
    locations: Record<string, boolean>,
    id = 1,
): ServerType {
    return {
        id,
        name,
        architecture: name.startsWith("cax") ? "arm" : "x86",
        locations: Object.entries(locations).map(([loc, available]) => ({
            name: loc,
            available,
            deprecation: null,
        })),
    };
}
