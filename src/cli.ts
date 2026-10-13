#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { z } from "zod";
import { channelsFromEnv, createAlerter } from "./alerts";
import { manifestFromFlags, options, usage } from "./flags";
import { createHcloud } from "./hcloud";
import { loadManifest, parseManifest } from "./manifest";
import { run } from "./run";

function fail(message: string): never {
    console.error(message);
    process.exit(2);
}

let parsed: ReturnType<
    typeof parseArgs<{ options: typeof options; allowPositionals: true }>
>;
try {
    parsed = parseArgs({
        args: Bun.argv.slice(2),
        options,
        allowPositionals: true,
    });
} catch (error) {
    fail(
        `${error instanceof Error ? error.message : String(error)}\n\n${usage}`,
    );
}
const { values, positionals } = parsed;

if (values.help) {
    console.log(usage);
    process.exit(0);
}

const [path] = positionals;
const oneOff = values.target !== undefined;
if (positionals.length > 1 || (path === undefined) === !oneOff) {
    fail(`Pass either a Manifest file or --target, not both.\n\n${usage}`);
}

const token = process.env.HCLOUD_TOKEN;
if (!token) fail("HCLOUD_TOKEN is not set.");

const manifest = await (path === undefined
    ? parseManifest(manifestFromFlags(values), process.cwd())
    : loadManifest(path)
).catch((error: unknown) =>
    fail(
        `Invalid ${path === undefined ? "flags" : `Manifest ${path}`}:\n${
            error instanceof z.ZodError
                ? z.prettifyError(error)
                : error instanceof Error
                  ? error.message
                  : String(error)
        }`,
    ),
);

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
