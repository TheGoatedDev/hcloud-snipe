#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { channelsFromEnv, createAlerter } from "./alerts";
import { createHcloud } from "./hcloud";
import { loadManifest } from "./manifest";
import { run } from "./run";

const usage = "usage: hcloud-snipe <manifest.yaml> [--dry-run]";

const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
});

if (values.help) {
    console.log(usage);
    process.exit(0);
}

const [path] = positionals;
if (path === undefined || positionals.length > 1) {
    console.error(usage);
    process.exit(2);
}

const token = process.env.HCLOUD_TOKEN;
if (!token) {
    console.error("HCLOUD_TOKEN is not set.");
    process.exit(2);
}

const manifest = await loadManifest(path).catch((error: unknown) => {
    console.error(
        `Invalid Manifest ${path}:\n${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
});

let channels: ReturnType<typeof channelsFromEnv>;
try {
    channels = channelsFromEnv();
} catch (error) {
    console.error(
        `Invalid alert config: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
}
const alerter = createAlerter(channels);

// Explicit handlers: as PID 1 in Docker, unhandled SIGTERM is ignored.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => process.exit(0));
}

const dryRun = values["dry-run"];
console.error(
    `[${manifest.name}] ${dryRun ? "Dry run: " : ""}polling every ${manifest.poll_interval}s; alerts: ${["stdout", ...channels.map((c) => c.name)].join(", ")}`,
);
const code = await run({
    manifest,
    hcloud: createHcloud({ token }),
    dryRun,
    alert: alerter.alert,
});
await alerter.flush();
process.exit(code);
