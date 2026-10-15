<div align="center">

<img src="docs/logo.svg" width="112" alt="">

# hcloud-snipe

**Create Hetzner Cloud servers the moment a sold-out type comes back in stock.**

[![CI](https://github.com/TheGoatedDev/hcloud-snipe/actions/workflows/ci.yml/badge.svg)](https://github.com/TheGoatedDev/hcloud-snipe/actions/workflows/ci.yml) [![Docker image](https://img.shields.io/badge/ghcr.io-hcloud--snipe-e5243b?logo=docker&logoColor=white)](https://github.com/TheGoatedDev/hcloud-snipe/pkgs/container/hcloud-snipe) [![Platforms](https://img.shields.io/badge/platform-amd64%20%7C%20arm64-14161a)](#install) [![License: MIT](https://img.shields.io/badge/license-MIT-14161a)](LICENSE)

[Quick start](#quick-start) · [Manifests](#manifests) · [How it works](#how-it-works) · [Alerts](#alerts) · [Docker Compose](#docker-compose)

</div>

<br>

```console
$ docker run --rm -e HCLOUD_TOKEN -v "$PWD:/config:ro" \
    ghcr.io/thegoateddev/hcloud-snipe /config/manifest.yaml
[homelab] polling every 5s; alerts: stdout, ntfy
lost race for cax21@fsn1 (snipe web): resource_unavailable
2026-10-15T07:12:03.114Z [homelab] Claim: web-1 on cax21@nbg1 (snipe web) 198.51.100.7, 2001:db8:7::/64
2026-10-15T07:12:04.902Z [homelab] Claim: web-2 on cax21@nbg1 (snipe web) 198.51.100.8, 2001:db8:8::/64
2026-10-15T07:12:04.903Z [homelab] Snipe web Fulfilled
```

Hetzner Cloud keeps running out of the cheap server types (CX, CAX, some CCX sizes in some locations). hcloud-snipe polls the Hetzner Cloud API and creates the servers you asked for as soon as one of your acceptable type/location pairs can be ordered again.

- **Ranked fallbacks.** List the type/location pairs you'd accept, best first. It takes the best one in stock.
- **Never over-buys.** Every server it creates is labelled and counted before the next create, so restarts and crashes can't push you past `count`.
- **Checks before it waits.** Unknown types, wrong locations, missing SSH keys, firewalls or images, and network-zone mismatches fail at startup, not three days later.
- **Alerts where you look.** Discord, Slack, Telegram, ntfy, email or any webhook.
- **Polite to your API budget.** One or two requests per poll, with automatic back-off near the 3600/hour project limit.

> [!WARNING]
> Without `--dry-run`, hcloud-snipe creates real servers on your account, and Hetzner bills each one for at least an hour. Start with `--dry-run` to check your setup and see how often stock appears.

## Install

hcloud-snipe ships as a Docker image for linux/amd64 and linux/arm64:

```sh
docker run --rm ghcr.io/thegoateddev/hcloud-snipe --help
```

To run from source instead, install [Bun](https://bun.com) 1.4 or newer, clone this repo, run `bun install`, and use `bun src/cli.ts` wherever the examples below use the image.

Create an API token with read/write access in the Hetzner Console (your project, Security, API tokens) and export it as `HCLOUD_TOKEN`.

## Quick start

Tell me when a `cax21` can be ordered in Falkenstein or Nuremberg:

```sh
export HCLOUD_TOKEN=...
docker run --rm -it -e HCLOUD_TOKEN ghcr.io/thegoateddev/hcloud-snipe \
  --target cax21@fsn1,cax21@nbg1 --dry-run
```

Create one as soon as it can be:

```sh
docker run --rm -it -e HCLOUD_TOKEN ghcr.io/thegoateddev/hcloud-snipe \
  --target cax21@fsn1,cax21@nbg1 --ssh-key laptop
```

The container exits 0 once the server exists. Pass `--help` for every flag.

## Manifests

For anything you want to keep, write a Manifest. Each Snipe in it is independent: it gets its own servers as soon as one of its Candidates is in stock, without waiting for the others.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/TheGoatedDev/hcloud-snipe/main/manifest.schema.json
name: homelab

snipes:
  - name: web
    count: 2
    target: [cax21@fsn1, cax21@nbg1, cax31@fsn1] # best first
    server:
      image: ubuntu-24.04
      ssh_keys: [laptop]
      user_data_file: ./cloud-init.yaml
      firewalls: [web]
      networks: [homelab-eu]

  - name: db
    target: [ccx13@fsn1, ccx13@nbg1]
    server:
      image: ubuntu-24.04
      ssh_keys: [laptop]
      public_net: { enable_ipv4: false }
```

Mount the directory holding the Manifest (and any `user_data_file` it references):

```sh
docker run --rm -it -e HCLOUD_TOKEN -v "$PWD:/config:ro" \
  ghcr.io/thegoateddev/hcloud-snipe /config/manifest.yaml --dry-run
```

See [`examples/manifest.yaml`](examples/manifest.yaml). The `server` fields follow Hetzner's `POST /servers` body. Images, SSH keys, firewalls, networks and placement groups can be given by name or numeric ID. Servers are named `{snipe}-{n}` (`web-1`, `web-2`) unless you set `server.name`, which must contain `{n}`.

Before it starts waiting, hcloud-snipe checks the Manifest against your project and lists everything wrong at once: unknown types, a type that isn't sold in a location, a missing image for the type's architecture, missing SSH keys or firewalls, a Candidate outside a network's zone.

## How it works

- Every `poll_interval` seconds (default 5) it reads `GET /v1/server_types`, which reports per location whether each type can be ordered.
- When a Candidate is available it creates a server there right away. If the stock is gone by the time the create lands (`resource_unavailable`, `placement_error`), it tries the next available Candidate, then waits for the next poll.
- Servers it creates get two labels, `hcloud-snipe/manifest=<name>` and `hcloud-snipe/snipe=<name>`. Before each create it counts the servers carrying them, so a restart or a crash never creates more than `count`. If you delete one of those servers while its Snipe is still waiting for the rest, it will be replaced.
- Polling costs one or two requests out of the project's 3600 per hour. Below 20% of the budget left it slows to one poll every 30 s, and after a 429 it pauses for up to a minute.
- It exits 1 on an invalid token, an exhausted project server limit (`resource_limit_exceeded`) or any other error that retrying won't fix.

## Alerts

Every Alert goes to stdout. Set any of these to also send it elsewhere:

| Channel  | Environment                                                                       |
| -------- | --------------------------------------------------------------------------------- |
| Webhook  | `HCLOUD_SNIPE_WEBHOOK_URL` (JSON body: the Alert plus `message` and `timestamp`)  |
| ntfy     | `HCLOUD_SNIPE_NTFY_URL` (e.g. `https://ntfy.sh/my-topic`), `HCLOUD_SNIPE_NTFY_TOKEN` |
| Discord  | `HCLOUD_SNIPE_DISCORD_WEBHOOK_URL`                                                |
| Slack    | `HCLOUD_SNIPE_SLACK_WEBHOOK_URL`                                                  |
| Telegram | `HCLOUD_SNIPE_TELEGRAM_BOT_TOKEN` and `HCLOUD_SNIPE_TELEGRAM_CHAT_ID`             |
| Email    | `HCLOUD_SNIPE_SMTP_URL` (`smtps://user:pass@host`), `HCLOUD_SNIPE_EMAIL_FROM`, `HCLOUD_SNIPE_EMAIL_TO` (comma-separated) |

You get an Alert for each server created, each Snipe and the whole Manifest being done, and fatal errors. In a dry run you get one each time a Candidate comes into stock. Channel settings live in the environment rather than the Manifest so you can commit Manifests without leaking webhook URLs.

## Docker Compose

```yaml
services:
  hcloud-snipe:
    image: ghcr.io/thegoateddev/hcloud-snipe:0.1
    command: /config/manifest.yaml
    volumes:
      - ./manifest.yaml:/config/manifest.yaml:ro
      - ./cloud-init.yaml:/config/cloud-init.yaml:ro
    environment:
      HCLOUD_TOKEN: ${HCLOUD_TOKEN}
      HCLOUD_SNIPE_NTFY_URL: https://ntfy.sh/my-topic
    restart: on-failure
```

Use `restart: on-failure`, not `always` or `unless-stopped`. The container exits 0 once the Manifest is done. If it does get restarted, it sees the labelled servers, logs that it is already done and exits again without alerting.

## Development

```sh
bun install
bun test
bun run lint
bun run typecheck
bun run schema   # regenerate manifest.schema.json after changing the Manifest schema
```

Tests run against an in-process fake of the Hetzner API, so they never touch a real account. Domain terms are defined in [`CONTEXT.md`](CONTEXT.md) and design decisions in [`docs/adr`](docs/adr).

## License

MIT
