import { claim, claimSelector, FatalError, type Resolved } from "./claim";
import {
    type Hcloud,
    HcloudError,
    type RateLimit,
    type ServerType,
} from "./hcloud";
import type { Candidate, Manifest, Snipe } from "./manifest";
import { validate } from "./validate";

export type Alert =
    | {
          kind: "sighting";
          manifest: string;
          snipe: string;
          candidate: Candidate;
      }
    | {
          kind: "claim";
          manifest: string;
          snipe: string;
          candidate: Candidate;
          server: string;
          ipv4: string | null;
          ipv6: string | null;
      }
    | { kind: "snipe-fulfilled"; manifest: string; snipe: string }
    | { kind: "manifest-fulfilled"; manifest: string }
    | { kind: "fatal"; manifest: string; error: string };

export const candidateKey = (c: Candidate) => `${c.type}@${c.location}`;

export function formatAlert(alert: Alert): string {
    switch (alert.kind) {
        case "sighting":
            return `[${alert.manifest}] Sighting: ${candidateKey(alert.candidate)} is orderable (snipe ${alert.snipe})`;
        case "claim": {
            const ips = [alert.ipv4, alert.ipv6].filter(Boolean).join(", ");
            return `[${alert.manifest}] Claim: ${alert.server} on ${candidateKey(alert.candidate)} (snipe ${alert.snipe})${ips ? ` ${ips}` : ""}`;
        }
        case "snipe-fulfilled":
            return `[${alert.manifest}] Snipe ${alert.snipe} Fulfilled`;
        case "manifest-fulfilled":
            return `[${alert.manifest}] Manifest Fulfilled`;
        case "fatal":
            return `[${alert.manifest}] Fatal: ${alert.error}`;
    }
}

/** Keys (`type@location`) of everything Hetzner reports as orderable right now. */
export function orderable(types: ServerType[], now = Date.now()): Set<string> {
    const keys = new Set<string>();
    for (const type of types) {
        for (const loc of type.locations) {
            const retired =
                loc.deprecation !== null &&
                Date.parse(loc.deprecation.unavailable_after) <= now;
            if (loc.available && !retired) keys.add(`${type.name}@${loc.name}`);
        }
    }
    return keys;
}

const LOW_BUDGET = 0.2;
const LOW_BUDGET_DELAY = 30_000;
const MAX_RATE_LIMITED_DELAY = 60_000;

/** Delay before the next poll, slowing down when the project's request budget runs low. */
export function nextDelay(
    interval: number,
    rateLimit: RateLimit | undefined,
): number {
    if (
        rateLimit !== undefined &&
        rateLimit.remaining < rateLimit.limit * LOW_BUDGET
    ) {
        return Math.max(interval, LOW_BUDGET_DELAY);
    }
    return interval;
}

/**
 * Delay after a 429. RateLimit-Reset is when the budget is *fully* refilled (up to an hour away),
 * but it refills at 1 request/s, so waiting at most a minute is enough to poll again.
 */
export function rateLimitedDelay(
    interval: number,
    rateLimit: RateLimit | undefined,
    now = Date.now(),
): number {
    const untilReset =
        rateLimit === undefined
            ? MAX_RATE_LIMITED_DELAY
            : rateLimit.reset * 1000 - now;
    return Math.min(Math.max(interval, untilReset), MAX_RATE_LIMITED_DELAY);
}

/** Polls until the Manifest is Fulfilled (or forever in a Dry run, until aborted). Returns an exit code. */
export async function run({
    manifest,
    hcloud,
    dryRun,
    alert,
    log = console.error,
    sleep = Bun.sleep,
    signal,
}: {
    manifest: Manifest;
    hcloud: Hcloud;
    dryRun: boolean;
    alert: (alert: Alert) => Promise<void> | void;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<unknown>;
    signal?: AbortSignal;
}): Promise<number> {
    const interval = manifest.poll_interval * 1000;
    const types = [
        ...new Set(manifest.snipes.flatMap((s) => s.target.map((c) => c.type))),
    ];
    const fatal = async (error: unknown) => {
        await alert({
            kind: "fatal",
            manifest: manifest.name,
            error: error instanceof Error ? error.message : String(error),
        });
        return 1;
    };
    const isFatal = (error: unknown) =>
        error instanceof FatalError ||
        (error instanceof HcloudError &&
            (error.status === 401 || error.status === 403));

    // Snipes still waiting for Claims, with their resolved resource IDs. Set up inside the
    // loop so rate limits and transient errors at startup are retried like any poll.
    let pending: Map<Snipe, Resolved> | undefined;
    // `snipe/type@location` pairs that were orderable on the previous poll.
    let seen = new Set<string>();

    while (!signal?.aborted) {
        let delay = interval;
        try {
            if (pending === undefined) {
                const resolved = await validate(hcloud, manifest);
                pending = new Map();
                if (!dryRun) {
                    for (const [snipe, ids] of resolved) {
                        const claims = await hcloud.servers(
                            claimSelector(manifest, snipe),
                        );
                        if (claims.length < snipe.count)
                            pending.set(snipe, ids);
                    }
                    if (pending.size === 0) {
                        log(`[${manifest.name}] already Fulfilled`);
                        return 0;
                    }
                }
            }
            const available = orderable(await hcloud.serverTypes(types));
            if (dryRun) {
                const current = new Set<string>();
                for (const snipe of manifest.snipes) {
                    for (const candidate of snipe.target) {
                        if (!available.has(candidateKey(candidate))) continue;
                        const key = `${snipe.name}/${candidateKey(candidate)}`;
                        current.add(key);
                        if (!seen.has(key)) {
                            await alert({
                                kind: "sighting",
                                manifest: manifest.name,
                                snipe: snipe.name,
                                candidate,
                            });
                        }
                    }
                }
                seen = current;
            }
            for (const [snipe, resolved] of pending) {
                const sighted = snipe.target.filter((c) =>
                    available.has(candidateKey(c)),
                );
                if (sighted.length === 0) continue;
                const fulfilled = await claim({
                    hcloud,
                    manifest,
                    snipe,
                    resolved,
                    sighted,
                    log,
                    onClaim: (server, candidate) =>
                        alert({
                            kind: "claim",
                            manifest: manifest.name,
                            snipe: snipe.name,
                            candidate,
                            server: server.name,
                            ipv4: server.public_net.ipv4?.ip ?? null,
                            ipv6: server.public_net.ipv6?.ip ?? null,
                        }),
                });
                if (fulfilled) {
                    pending.delete(snipe);
                    await alert({
                        kind: "snipe-fulfilled",
                        manifest: manifest.name,
                        snipe: snipe.name,
                    });
                }
            }
            if (!dryRun && pending.size === 0) {
                await alert({
                    kind: "manifest-fulfilled",
                    manifest: manifest.name,
                });
                return 0;
            }
            delay = nextDelay(interval, hcloud.rateLimit());
        } catch (error) {
            if (isFatal(error)) return fatal(error);
            if (error instanceof HcloudError && error.status === 429) {
                delay = rateLimitedDelay(interval, hcloud.rateLimit());
                log(`rate limited, next poll in ${Math.round(delay / 1000)}s`);
            } else {
                log(
                    `poll failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        await sleep(delay);
    }
    return 0;
}
