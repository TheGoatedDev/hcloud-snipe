// Minimal hand-rolled Hetzner Cloud API client (see docs/adr/0001).

export const HCLOUD_API = "https://api.hetzner.cloud/v1";

export type ServerTypeLocation = {
    name: string;
    available: boolean;
    deprecation: { unavailable_after: string } | null;
};

export type ServerType = {
    id: number;
    name: string;
    architecture: string;
    locations: ServerTypeLocation[];
};

export type Server = {
    id: number;
    name: string;
    labels: Record<string, string>;
    server_type: { name: string };
    location: { name: string };
    public_net: {
        ipv4: { ip: string } | null;
        ipv6: { ip: string } | null;
    };
};

export type CreateServerBody = {
    name: string;
    server_type: string;
    location: string;
    image: string;
    ssh_keys?: string[];
    user_data?: string;
    labels?: Record<string, string>;
    firewalls?: { firewall: number }[];
    networks?: number[];
    public_net?: { enable_ipv4: boolean; enable_ipv6: boolean };
    placement_group?: number;
};

export type RateLimit = { limit: number; remaining: number; reset: number };

export class HcloudError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
    ) {
        super(`${code}: ${message}`);
    }
}

type Pagination = { next_page: number | null; last_page: number | null };

export type Hcloud = ReturnType<typeof createHcloud>;

export function createHcloud({
    token,
    baseUrl = HCLOUD_API,
}: {
    token: string;
    baseUrl?: string;
}) {
    let rateLimit: RateLimit | undefined;
    // Page count of an unfiltered server_types listing, learned on first use.
    let serverTypePages: number | undefined;

    async function request<T>(
        method: string,
        path: string,
        body?: unknown,
    ): Promise<T> {
        const res = await fetch(`${baseUrl}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                ...(body === undefined
                    ? {}
                    : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

        const limit = res.headers.get("RateLimit-Limit");
        if (limit !== null) {
            rateLimit = {
                limit: Number(limit),
                remaining: Number(res.headers.get("RateLimit-Remaining")),
                reset: Number(res.headers.get("RateLimit-Reset")),
            };
        }

        const json = (await res.json().catch(() => null)) as {
            error?: { code?: string; message?: string };
        } | null;
        if (!res.ok) {
            throw new HcloudError(
                res.status,
                json?.error?.code ?? "http_error",
                json?.error?.message ?? `HTTP ${res.status}`,
            );
        }
        return json as T;
    }

    async function list<K extends string, T>(
        key: K,
        path: string,
        query: Record<string, string> = {},
    ): Promise<{ items: T[]; pages: number }> {
        const items: T[] = [];
        let page: number | null = 1;
        let pages = 0;
        while (page !== null) {
            const params = new URLSearchParams({
                ...query,
                per_page: "50",
                page: String(page),
            });
            const res = await request<
                Record<K, T[]> & { meta?: { pagination?: Pagination } }
            >("GET", `${path}?${params}`);
            items.push(...res[key]);
            pages++;
            page = res.meta?.pagination?.next_page ?? null;
        }
        return { items, pages };
    }

    return {
        /** Last rate-limit headers seen, if any. */
        rateLimit: () => rateLimit,

        /**
         * Server types with per-location availability. With `names`, uses whichever costs
         * fewer requests: one `?name=` request per type, or paging the full list.
         */
        async serverTypes(names?: string[]): Promise<ServerType[]> {
            const unique = [...new Set(names)];
            if (
                names !== undefined &&
                serverTypePages !== undefined &&
                unique.length < serverTypePages
            ) {
                const lists = await Promise.all(
                    unique.map(
                        async (name) =>
                            (
                                await list<"server_types", ServerType>(
                                    "server_types",
                                    "/server_types",
                                    { name },
                                )
                            ).items,
                    ),
                );
                return lists.flat();
            }
            const { items, pages } = await list<"server_types", ServerType>(
                "server_types",
                "/server_types",
            );
            serverTypePages = pages;
            return names === undefined
                ? items
                : items.filter((t) => unique.includes(t.name));
        },

        async servers(labelSelector: string): Promise<Server[]> {
            return (
                await list<"servers", Server>("servers", "/servers", {
                    label_selector: labelSelector,
                })
            ).items;
        },

        async createServer(body: CreateServerBody): Promise<Server> {
            return (await request<{ server: Server }>("POST", "/servers", body))
                .server;
        },

        /** Resources matching a name or ID; empty when none exist. */
        async find<T>(
            resource:
                | "images"
                | "ssh_keys"
                | "firewalls"
                | "networks"
                | "placement_groups",
            ref: string | number,
            query: Record<string, string> = {},
        ): Promise<T[]> {
            if (typeof ref === "number") {
                try {
                    const res = await request<Record<string, T>>(
                        "GET",
                        `/${resource}/${ref}`,
                    );
                    return Object.values(res);
                } catch (error) {
                    if (error instanceof HcloudError && error.status === 404)
                        return [];
                    throw error;
                }
            }
            return (
                await list<string, T>(resource, `/${resource}`, {
                    ...query,
                    name: ref,
                })
            ).items;
        },
    };
}
