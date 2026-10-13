import {
    type Hcloud,
    HcloudError,
    type RateLimit,
    type ServerType,
} from "./hcloud";
import type { Candidate, Manifest } from "./manifest";

export type Alert =
    | {
          kind: "sighting";
          manifest: string;
          snipe: string;
          candidate: Candidate;
      }
    | { kind: "fatal"; manifest: string; error: string };

export const candidateKey = (c: Candidate) => `${c.type}@${c.location}`;

export function formatAlert(alert: Alert): string {
    switch (alert.kind) {
        case "sighting":
            return `[${alert.manifest}] Sighting: ${candidateKey(alert.candidate)} is orderable (snipe ${alert.snipe})`;
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

/** Polls until aborted, alerting on each Candidate that becomes orderable. Returns an exit code. */
export async function run({
    manifest,
    hcloud,
    alert,
    log = console.error,
    sleep = Bun.sleep,
    signal,
}: {
    manifest: Manifest;
    hcloud: Hcloud;
    alert: (alert: Alert) => Promise<void> | void;
    log?: (message: string) => void;
    sleep?: (ms: number) => Promise<unknown>;
    signal?: AbortSignal;
}): Promise<number> {
    const interval = manifest.poll_interval * 1000;
    const types = [
        ...new Set(manifest.snipes.flatMap((s) => s.target.map((c) => c.type))),
    ];
    // `snipe/type@location` pairs that were orderable on the previous poll.
    let seen = new Set<string>();

    while (!signal?.aborted) {
        let delay = interval;
        try {
            const available = orderable(await hcloud.serverTypes(types));
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
            delay = nextDelay(interval, hcloud.rateLimit());
        } catch (error) {
            if (
                error instanceof HcloudError &&
                (error.status === 401 || error.status === 403)
            ) {
                await alert({
                    kind: "fatal",
                    manifest: manifest.name,
                    error: error.message,
                });
                return 1;
            }
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
