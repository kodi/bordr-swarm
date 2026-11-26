import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ProjectsConfigSchema, SwarmConfigSchema } from "../src/lib/schemas.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function writeSchema(schema: z.ZodType, outRelPath: string, title: string): void {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
  const enriched = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
    ...jsonSchema,
  };
  const outPath = resolve(repoRoot, outRelPath);
  writeFileSync(outPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
  console.log(`[schemas] Generated ${outRelPath}`);
}

writeSchema(SwarmConfigSchema, "config/swarm.schema.json", "Swarm Configuration");
writeSchema(ProjectsConfigSchema, "config/projects.schema.json", "Swarm Projects Configuration");
