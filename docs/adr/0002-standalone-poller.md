# Standalone poller, independent of Hetzner-Cloud-Radar

hcloud-snipe polls `GET /v1/server_types` itself instead of consuming availability from the author's Hetzner-Cloud-Radar project. Relying on Radar would put its latency and uptime between a Sighting and a Claim, and it would tie an OSS tool to a service its users don't run. One poll (one or two pages of 50) covers every type and location, so the cost of polling doesn't grow with the Manifest.
