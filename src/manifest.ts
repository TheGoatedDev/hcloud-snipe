import { dirname, resolve } from "node:path";
import { z } from "zod";

// Names end up in label values and server names, so they must be valid for both.
const name = z
    .string()
    .regex(
        /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
        "lowercase letters, digits and '-', 1-63 chars, no leading or trailing '-'",
    );

// A Hetzner resource referenced by name or ID; resolved against the API at startup.
const ref = z.union([z.string().min(1), z.number().int().positive()]);

export const RESERVED_LABEL_PREFIX = "hcloud-snipe/";

export const candidate = z
    .string()
    .regex(/^[a-z0-9-]+@[a-z0-9-]+$/, "expected type@location, e.g. cax21@fsn1")
    .transform((value) => {
        const [type, location] = value.split("@") as [string, string];
        return { type, location };
    });

export type Candidate = z.output<typeof candidate>;

const server = z.strictObject({
    name: z
        .string()
        .includes("{n}", { message: "name template must contain {n}" })
        .default("{snipe}-{n}"),
    image: ref,
    ssh_keys: z.array(ref).default([]),
    user_data_file: z.string().min(1).optional(),
    labels: z
        .record(z.string(), z.string())
        .refine(
            (labels) =>
                Object.keys(labels).every(
                    (key) => !key.startsWith(RESERVED_LABEL_PREFIX),
                ),
            `label keys starting with ${RESERVED_LABEL_PREFIX} are reserved`,
        )
        .default({}),
    firewalls: z.array(ref).default([]),
    networks: z.array(ref).default([]),
    public_net: z
        .strictObject({
            enable_ipv4: z.boolean().default(true),
            enable_ipv6: z.boolean().default(true),
        })
        .default({ enable_ipv4: true, enable_ipv6: true }),
    placement_group: ref.optional(),
});

const snipe = z.strictObject({
    name,
    count: z.number().int().min(1).default(1),
    target: z
        .array(candidate)
        .min(1)
        .refine(
            (target) =>
                new Set(target.map((c) => `${c.type}@${c.location}`)).size ===
                target.length,
            "target lists a Candidate more than once",
        ),
    server,
});

export type Snipe = z.output<typeof snipe>;

export const manifest = z.strictObject({
    $schema: z.string().optional(),
    name,
    poll_interval: z.number().min(1).default(5),
    snipes: z
        .array(snipe)
        .min(1)
        .refine(
            (snipes) =>
                new Set(snipes.map((s) => s.name)).size === snipes.length,
            "snipe names must be unique",
        ),
});

export type Manifest = z.output<typeof manifest>;

/** Parses a Manifest file; user_data_file paths become absolute and must exist. */
export async function loadManifest(path: string): Promise<Manifest> {
    const parsed = manifest.parse(Bun.YAML.parse(await Bun.file(path).text()));
    for (const s of parsed.snipes) {
        if (s.server.user_data_file === undefined) continue;
        s.server.user_data_file = resolve(
            dirname(path),
            s.server.user_data_file,
        );
        if (!(await Bun.file(s.server.user_data_file).exists())) {
            throw new Error(
                `snipe ${s.name}: user_data_file not found: ${s.server.user_data_file}`,
            );
        }
    }
    return parsed;
}
