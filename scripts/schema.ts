import { z } from "zod";
import { manifest } from "../src/manifest";

export const manifestJsonSchema = () =>
    `${JSON.stringify(z.toJSONSchema(manifest, { io: "input" }), null, 4)}\n`;

if (import.meta.main) {
    await Bun.write("manifest.schema.json", manifestJsonSchema());
}
