import nodemailer, { type Transporter } from "nodemailer";
import { type Alert, formatAlert } from "./run";

/** Somewhere Alerts are delivered besides stdout. */
export type Channel = {
    name: string;
    send: (alert: Alert, message: string) => Promise<void>;
};

const TIMEOUT = 10_000;
const URGENT = new Set<Alert["kind"]>(["claim", "fatal", "manifest-fulfilled"]);

async function post(url: string, init: RequestInit): Promise<void> {
    const res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.timeout(TIMEOUT),
        ...init,
    });
    if (!res.ok) {
        throw new Error(
            `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
    }
}

const postJson = (url: string, body: unknown) =>
    post(url, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

/**
 * Channels configured through HCLOUD_SNIPE_* env vars. Secrets stay out of the Manifest so
 * Manifests can be committed. Throws when a channel is only partly configured.
 */
export function channelsFromEnv(
    env: Record<string, string | undefined> = process.env,
    {
        telegramApi = "https://api.telegram.org",
        mailTransport = (url: string): Transporter =>
            nodemailer.createTransport(url),
    } = {},
): Channel[] {
    const get = (name: string) => env[`HCLOUD_SNIPE_${name}`] || undefined;
    const together = (...names: string[]) => {
        const values = names.map(get);
        const set = values.filter((v) => v !== undefined).length;
        if (set > 0 && set < names.length) {
            throw new Error(
                `set all of ${names.map((n) => `HCLOUD_SNIPE_${n}`).join(", ")} or none`,
            );
        }
        return set === names.length ? (values as string[]) : undefined;
    };
    const channels: Channel[] = [];

    const webhook = get("WEBHOOK_URL");
    if (webhook) {
        channels.push({
            name: "webhook",
            send: (alert, message) =>
                postJson(webhook, {
                    ...alert,
                    message,
                    timestamp: new Date().toISOString(),
                }),
        });
    }

    const ntfy = get("NTFY_URL");
    if (ntfy) {
        const token = get("NTFY_TOKEN");
        channels.push({
            name: "ntfy",
            send: (alert, message) =>
                post(ntfy, {
                    headers: {
                        Title: "hcloud-snipe",
                        Priority: URGENT.has(alert.kind) ? "high" : "default",
                        Tags: alert.kind,
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                    body: message,
                }),
        });
    }

    const discord = get("DISCORD_WEBHOOK_URL");
    if (discord) {
        channels.push({
            name: "discord",
            send: (_, message) => postJson(discord, { content: message }),
        });
    }

    const slack = get("SLACK_WEBHOOK_URL");
    if (slack) {
        channels.push({
            name: "slack",
            send: (_, message) => postJson(slack, { text: message }),
        });
    }

    const telegram = together("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID");
    if (telegram) {
        const [token, chatId] = telegram as [string, string];
        channels.push({
            name: "telegram",
            send: (_, message) =>
                postJson(`${telegramApi}/bot${token}/sendMessage`, {
                    chat_id: chatId,
                    text: message,
                }),
        });
    }

    const email = together("SMTP_URL", "EMAIL_FROM", "EMAIL_TO");
    if (email) {
        const [smtpUrl, from, to] = email as [string, string, string];
        const transport = mailTransport(smtpUrl);
        channels.push({
            name: "email",
            send: async (_, message) => {
                await transport.sendMail({
                    from,
                    to: to.split(",").map((a) => a.trim()),
                    subject: message.split("\n")[0],
                    text: message,
                });
            },
        });
    }

    return channels;
}

/**
 * Prints every Alert and fans it out to the channels in the background, so a slow channel
 * never delays a Claim. A failing channel is logged, never fatal. Call `flush` before exit.
 */
export function createAlerter(
    channels: Channel[],
    {
        print = console.log,
        log = console.error,
    }: { print?: (line: string) => void; log?: (line: string) => void } = {},
) {
    const inFlight = new Set<Promise<void>>();
    return {
        alert(alert: Alert) {
            const message = formatAlert(alert);
            print(`${new Date().toISOString()} ${message}`);
            for (const channel of channels) {
                const sending = channel
                    .send(alert, message)
                    .catch((error: unknown) =>
                        log(
                            `alert via ${channel.name} failed: ${error instanceof Error ? error.message : String(error)}`,
                        ),
                    )
                    .finally(() => inFlight.delete(sending));
                inFlight.add(sending);
            }
        },
        flush: async () => {
            await Promise.all(inFlight);
        },
    };
}
