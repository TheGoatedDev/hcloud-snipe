# TypeScript on Bun with a hand-rolled API client

We write hcloud-snipe in TypeScript on Bun and call the Hetzner Cloud API with plain `fetch`, rather than using Go and Hetzner's official `hcloud-go` SDK. TypeScript is the author's familiar stack, and code can be shared with Hetzner-Cloud-Radar, which is TypeScript and already has a `fetch`-based client for `GET /v1/server_types`. There is no official TypeScript SDK and the community ones are stale (some still call `/v1/datacenters`, which returns 410 since 2026-10-01). The tool only touches a handful of endpoints, so a small hand-written client is cheaper than a dependency or a generated client.

## Consequences

When Hetzner changes the API we find out from runtime errors, not type errors. Keep the client small and check it against the changelog.
