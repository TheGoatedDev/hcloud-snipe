import { FatalError, type Resolved } from "./claim";
import type { Hcloud } from "./hcloud";
import type { Manifest, Snipe } from "./manifest";

type Network = { id: number; subnets: { network_zone: string }[] };
type Image = { id: number; architecture: string };

/**
 * Checks every Snipe against the project before any waiting starts, and resolves names the
 * create body needs as IDs. Throws one FatalError listing every problem found.
 */
export async function validate(
    hcloud: Hcloud,
    manifest: Manifest,
    now = Date.now(),
): Promise<Map<Snipe, Resolved>> {
    const types = new Map(
        (
            await hcloud.serverTypes([
                ...new Set(
                    manifest.snipes.flatMap((s) => s.target.map((c) => c.type)),
                ),
            ])
        ).map((t) => [t.name, t]),
    );
    const zones = new Map(
        (await hcloud.locations()).map((l) => [l.name, l.network_zone]),
    );
    const problems: string[] = [];
    const resolved = new Map<Snipe, Resolved>();

    for (const snipe of manifest.snipes) {
        const problem = (message: string) =>
            problems.push(`snipe ${snipe.name}: ${message}`);
        const { server } = snipe;

        const architectures = new Set<string>();
        for (const c of snipe.target) {
            const key = `${c.type}@${c.location}`;
            const type = types.get(c.type);
            if (type === undefined) {
                problem(`unknown server type ${c.type}`);
                continue;
            }
            architectures.add(type.architecture);
            const loc = type.locations.find((l) => l.name === c.location);
            if (loc === undefined) {
                const sold = type.locations.map((l) => l.name).join(", ");
                problem(`${key} is not offered (${c.type} is sold in ${sold})`);
            } else if (
                loc.deprecation !== null &&
                Date.parse(loc.deprecation.unavailable_after) <= now
            ) {
                problem(`${key} has been retired`);
            }
        }

        for (const architecture of architectures) {
            const images = await hcloud.find<Image>("images", server.image, {
                architecture,
            });
            if (!images.some((i) => i.architecture === architecture)) {
                problem(`image ${server.image} not found for ${architecture}`);
            }
        }

        for (const key of server.ssh_keys) {
            if ((await hcloud.find("ssh_keys", key)).length === 0) {
                problem(`ssh key ${key} not found`);
            }
        }

        const one = async <T extends { id: number }>(
            resource: "firewalls" | "networks" | "placement_groups",
            ref: string | number,
        ): Promise<T | undefined> => {
            const found = await hcloud.find<T>(resource, ref);
            if (found.length !== 1) {
                const label = resource.replace(/s$/, "").replace("_", " ");
                problem(`${label} ${JSON.stringify(ref)} not found`);
            }
            return found.length === 1 ? found[0] : undefined;
        };

        const firewalls = await Promise.all(
            server.firewalls.map((f) => one("firewalls", f)),
        );
        const networks = await Promise.all(
            server.networks.map((n) => one<Network>("networks", n)),
        );
        const placementGroup =
            server.placement_group === undefined
                ? undefined
                : await one("placement_groups", server.placement_group);

        for (const [i, network] of networks.entries()) {
            if (network === undefined) continue;
            const networkZones = new Set(
                network.subnets.map((s) => s.network_zone),
            );
            for (const c of snipe.target) {
                const zone = zones.get(c.location);
                if (zone !== undefined && !networkZones.has(zone)) {
                    problem(
                        `${c.type}@${c.location} is in ${zone}, outside network ${JSON.stringify(server.networks[i])} (${[...networkZones].join(", ") || "no subnets"})`,
                    );
                }
            }
        }

        resolved.set(snipe, {
            firewalls: firewalls.flatMap((f) => (f ? [f.id] : [])),
            networks: networks.flatMap((n) => (n ? [n.id] : [])),
            ...(placementGroup ? { placement_group: placementGroup.id } : {}),
        });
    }

    if (problems.length > 0) {
        throw new FatalError(
            `invalid Manifest ${manifest.name}:\n  - ${problems.join("\n  - ")}`,
        );
    }
    return resolved;
}
