import { expect, test } from "bun:test";

const cli = (args: string[], env: Record<string, string> = {}) => {
    const proc = Bun.spawnSync(["bun", "src/cli.ts", ...args], {
        env: { PATH: process.env.PATH ?? "", HCLOUD_TOKEN: "x", ...env },
    });
    return { code: proc.exitCode, stderr: proc.stderr.toString() };
};

test("needs a Manifest file or --target, not both", () => {
    expect(cli([]).code).toBe(2);
    expect(cli(["m.yaml", "--target", "cax31@fsn1"]).code).toBe(2);
});

test("prints readable schema errors for bad flags", () => {
    const { code, stderr } = cli(["--target", "cax31", "--count", "0"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Invalid flags:");
    expect(stderr).toContain("expected type@location");
    expect(stderr).toContain("count");
});

test("rejects unknown flags", () => {
    const { code, stderr } = cli(["--target", "cax31@fsn1", "--nope"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--nope");
});

test("requires HCLOUD_TOKEN", () => {
    const { code, stderr } = cli(["--target", "cax31@fsn1"], {
        HCLOUD_TOKEN: "",
    });
    expect(code).toBe(2);
    expect(stderr).toContain("HCLOUD_TOKEN is not set.");
});
