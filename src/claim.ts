import {
    type CreateServerBody,
    type Hcloud,
    HcloudError,
    type Server,
} from "./hcloud";
import type { Candidate, Manifest, Snipe } from "./manifest";

export const MANIFEST_LABEL = "hcloud-snipe/manifest";
export const SNIPE_LABEL = "hcloud-snipe/snipe";

/** Create errors that mean the stock vanished between Sighting and Claim. */
const LOST_RACE = new Set(["resource_unavailable", "placement_error"]);

/** A config or account problem that retrying will not fix. */
export class FatalError extends Error {}

/** IDs the create body needs where the Manifest may have used names. */
export type Resolved = {
    firewalls: number[];
    networks: number[];
    placement_group?: number;
};

export const claimSelector = (manifest: Manifest, snipe: Snipe) =>
    `${MANIFEST_LABEL}=${manifest.name},${SNIPE_LABEL}=${snipe.name}`;

/** Lowest-numbered name from the Snipe's template that is not in `taken`. */
export function nextName(snipe: Snipe, taken: Set<string>): string {
    for (let n = 1; ; n++) {
        const name = snipe.server.name
            .replaceAll("{snipe}", snipe.name)
            .replaceAll("{n}", String(n));
        if (!taken.has(name)) return name;
    }
}

export async function createBody(
    manifest: Manifest,
    snipe: Snipe,
    resolved: Resolved,
    candidate: Candidate,
    name: string,
): Promise<CreateServerBody> {
    const { server } = snipe;
    return {
        name,
        server_type: candidate.type,
        location: candidate.location,
        image: String(server.image),
        ssh_keys: server.ssh_keys.map(String),
        ...(server.user_data_file === undefined
            ? {}
            : { user_data: await Bun.file(server.user_data_file).text() }),
        labels: {
            ...server.labels,
            [MANIFEST_LABEL]: manifest.name,
            [SNIPE_LABEL]: snipe.name,
        },
        firewalls: resolved.firewalls.map((firewall) => ({ firewall })),
        networks: resolved.networks,
        public_net: server.public_net,
        ...(resolved.placement_group === undefined
            ? {}
            : { placement_group: resolved.placement_group }),
    };
}

/**
 * Claims servers for one Snipe from its Sighted Candidates, best first, until it is Fulfilled
 * or every Sighted Candidate is lost. Counts existing Claims by label first, so restarts and
 * uncertain creates never over-claim. Returns whether the Snipe is Fulfilled.
 */
export async function claim({
    hcloud,
    manifest,
    snipe,
    resolved,
    sighted,
    onClaim,
    log,
}: {
    hcloud: Hcloud;
    manifest: Manifest;
    snipe: Snipe;
    resolved: Resolved;
    sighted: Candidate[];
    onClaim: (server: Server, candidate: Candidate) => Promise<void> | void;
    log: (message: string) => void;
}): Promise<boolean> {
    const existing = await hcloud.servers(claimSelector(manifest, snipe));
    let claims = existing.length;
    const taken = new Set(existing.map((s) => s.name));

    for (const candidate of sighted) {
        while (claims < snipe.count) {
            const name = nextName(snipe, taken);
            let server: Server;
            try {
                server = await hcloud.createServer(
                    await createBody(
                        manifest,
                        snipe,
                        resolved,
                        candidate,
                        name,
                    ),
                );
            } catch (error) {
                if (!(error instanceof HcloudError)) throw error;
                if (error.code === "uniqueness_error") {
                    taken.add(name);
                    continue;
                }
                if (LOST_RACE.has(error.code)) {
                    log(
                        `lost race for ${candidate.type}@${candidate.location} (snipe ${snipe.name}): ${error.code}`,
                    );
                    break;
                }
                if (error.status === 429 || error.status >= 500) throw error;
                throw new FatalError(`creating ${name}: ${error.message}`);
            }
            claims++;
            taken.add(server.name);
            await onClaim(server, candidate);
        }
    }
    return claims >= snipe.count;
}
