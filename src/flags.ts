import type { ParseArgsConfig } from "node:util";

export const usage = `usage:
  hcloud-snipe <manifest.yaml> [--dry-run]
  hcloud-snipe --target <type@location>... [options] [--dry-run]

One-off Snipe options (instead of a Manifest file):
  --target <type@location>    Candidate, best first; repeat or comma-separate (required)
  --name <name>               Snipe name, also used for server names (default: first type)
  --count <n>                 servers to Claim (default: 1)
  --image <name|id>           (default: ubuntu-24.04)
  --ssh-key <name|id>         repeatable
  --user-data-file <path>     cloud-init file
  --label <key=value>         repeatable
  --firewall <name|id>        repeatable
  --network <name|id>         repeatable
  --placement-group <name|id>
  --server-name <template>    supports {snipe} and {n} (default: {snipe}-{n})
  --no-ipv4, --no-ipv6        create without a public IPv4 / IPv6
  --poll-interval <seconds>   (default: 5)

  --dry-run                   report Sightings, never create servers
  -h, --help

Env: HCLOUD_TOKEN (required), HCLOUD_SNIPE_* alert channels.`;

export const options = {
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    target: { type: "string", multiple: true },
    name: { type: "string" },
    count: { type: "string" },
    image: { type: "string" },
    "ssh-key": { type: "string", multiple: true },
    "user-data-file": { type: "string" },
    label: { type: "string", multiple: true },
    firewall: { type: "string", multiple: true },
    network: { type: "string", multiple: true },
    "placement-group": { type: "string" },
    "server-name": { type: "string" },
    "no-ipv4": { type: "boolean", default: false },
    "no-ipv6": { type: "boolean", default: false },
    "poll-interval": { type: "string" },
} satisfies ParseArgsConfig["options"];

export type FlagValues = {
    target?: string[];
    name?: string;
    count?: string;
    image?: string;
    "ssh-key"?: string[];
    "user-data-file"?: string;
    label?: string[];
    firewall?: string[];
    network?: string[];
    "placement-group"?: string;
    "server-name"?: string;
    "no-ipv4"?: boolean;
    "no-ipv6"?: boolean;
    "poll-interval"?: string;
};

/** Digits mean an ID, like a bare number in YAML; anything else is a name. */
const ref = (value: string) => (/^\d+$/.test(value) ? Number(value) : value);

const num = (value: string | undefined) =>
    value === undefined ? undefined : Number(value);

/** An unvalidated Manifest holding one Snipe built from CLI flags. */
export function manifestFromFlags(values: FlagValues): unknown {
    const target = (values.target ?? [])
        .flatMap((t) => t.split(","))
        .map((t) => t.trim())
        .filter(Boolean);
    const labels = Object.fromEntries(
        (values.label ?? []).map((l) => {
            const i = l.indexOf("=");
            return i === -1 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)];
        }),
    );
    return {
        name: "cli",
        poll_interval: num(values["poll-interval"]),
        snipes: [
            {
                name: values.name ?? target[0]?.split("@")[0],
                count: num(values.count),
                target,
                server: {
                    name: values["server-name"],
                    image: ref(values.image ?? "ubuntu-24.04"),
                    ssh_keys: values["ssh-key"]?.map(ref),
                    user_data_file: values["user-data-file"],
                    labels,
                    firewalls: values.firewall?.map(ref),
                    networks: values.network?.map(ref),
                    public_net: {
                        enable_ipv4: !values["no-ipv4"],
                        enable_ipv6: !values["no-ipv6"],
                    },
                    placement_group:
                        values["placement-group"] === undefined
                            ? undefined
                            : ref(values["placement-group"]),
                },
            },
        ],
    };
}
