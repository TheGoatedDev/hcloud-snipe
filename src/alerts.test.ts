import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import nodemailer from "nodemailer";
import { channelsFromEnv, createAlerter } from "./alerts";
import type { Alert } from "./run";

type Received = {
    path: string;
    headers: Record<string, string>;
    body: string;
};

let received: Received[];
let status: number;
let receiver: ReturnType<typeof Bun.serve>;
let url: string;

beforeEach(() => {
    received = [];
    status = 200;
    receiver = Bun.serve({
        port: 0,
        fetch: async (req) => {
            received.push({
                path: new URL(req.url).pathname,
                headers: Object.fromEntries(req.headers),
                body: await req.text(),
            });
            return new Response("ok", { status });
        },
    });
    url = receiver.url.origin;
});
afterEach(() => receiver.stop(true));

const claim: Alert = {
    kind: "claim",
    manifest: "lab",
    snipe: "web",
    candidate: { type: "cax31", location: "fsn1" },
    server: "web-1",
    ipv4: "198.51.100.1",
    ipv6: null,
};
const message = "[lab] Claim: web-1 on cax31@fsn1 (snipe web) 198.51.100.1";

const allEnv = () => ({
    HCLOUD_SNIPE_WEBHOOK_URL: `${url}/webhook`,
    HCLOUD_SNIPE_NTFY_URL: `${url}/ntfy-topic`,
    HCLOUD_SNIPE_NTFY_TOKEN: "tk_ntfy",
    HCLOUD_SNIPE_DISCORD_WEBHOOK_URL: `${url}/discord`,
    HCLOUD_SNIPE_SLACK_WEBHOOK_URL: `${url}/slack`,
    HCLOUD_SNIPE_TELEGRAM_BOT_TOKEN: "123:abc",
    HCLOUD_SNIPE_TELEGRAM_CHAT_ID: "-100",
    HCLOUD_SNIPE_SMTP_URL: "smtp://user:pass@mail.example.com:587",
    HCLOUD_SNIPE_EMAIL_FROM: "snipe@example.com",
    HCLOUD_SNIPE_EMAIL_TO: "me@example.com, ops@example.com",
});

test("no env means no channels", () => {
    expect(channelsFromEnv({})).toEqual([]);
});

test("delivers an Alert to every configured channel", async () => {
    const mail = nodemailer.createTransport({ jsonTransport: true });
    const sendMail = spyOn(mail, "sendMail");
    const channels = channelsFromEnv(allEnv(), {
        telegramApi: url,
        mailTransport: (smtpUrl) => {
            expect(smtpUrl).toBe("smtp://user:pass@mail.example.com:587");
            return mail;
        },
    });
    expect(channels.map((c) => c.name)).toEqual([
        "webhook",
        "ntfy",
        "discord",
        "slack",
        "telegram",
        "email",
    ]);

    const printed: string[] = [];
    const alerter = createAlerter(channels, { print: (l) => printed.push(l) });
    alerter.alert(claim);
    await alerter.flush();

    expect(printed[0]).toEndWith(` ${message}`);
    const by = (path: string) => received.find((r) => r.path === path);

    expect(JSON.parse(by("/webhook")?.body ?? "")).toMatchObject({
        ...claim,
        message,
    });
    expect(by("/ntfy-topic")).toMatchObject({
        body: message,
        headers: {
            title: "hcloud-snipe",
            priority: "high",
            tags: "claim",
            authorization: "Bearer tk_ntfy",
        },
    });
    expect(JSON.parse(by("/discord")?.body ?? "")).toEqual({
        content: message,
    });
    expect(JSON.parse(by("/slack")?.body ?? "")).toEqual({ text: message });
    expect(JSON.parse(by("/bot123:abc/sendMessage")?.body ?? "")).toEqual({
        chat_id: "-100",
        text: message,
    });
    const sent = (await sendMail.mock.results[0]?.value) as { message: string };
    expect(JSON.parse(sent.message)).toMatchObject({
        subject: message,
        text: message,
        to: [{ address: "me@example.com" }, { address: "ops@example.com" }],
    });
});

test("rejects a partly configured channel", () => {
    expect(() =>
        channelsFromEnv({ HCLOUD_SNIPE_TELEGRAM_BOT_TOKEN: "123:abc" }),
    ).toThrow(
        "set all of HCLOUD_SNIPE_TELEGRAM_BOT_TOKEN, HCLOUD_SNIPE_TELEGRAM_CHAT_ID or none",
    );
});

test("a failing channel is logged and does not stop the others", async () => {
    const logs: string[] = [];
    const alerter = createAlerter(
        [
            {
                name: "broken",
                send: async () => {
                    throw new Error("boom");
                },
            },
            ...channelsFromEnv({
                HCLOUD_SNIPE_SLACK_WEBHOOK_URL: `${url}/slack`,
            }),
        ],
        { print: () => {}, log: (l) => logs.push(l) },
    );
    alerter.alert(claim);
    await alerter.flush();
    expect(logs).toEqual(["alert via broken failed: boom"]);
    expect(received.map((r) => r.path)).toEqual(["/slack"]);

    status = 500;
    alerter.alert(claim);
    await alerter.flush();
    expect(logs).toContain("alert via slack failed: HTTP 500: ok");
});
