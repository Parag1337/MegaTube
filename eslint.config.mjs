import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Env-gated alternate build dir used by the performance harness
    // (NEXT_DIST_DIR, see docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md).
    ".next-perf/**",
    // Prisma client output (schema: generator client output = "../generated").
    "generated/**",
  ]),
]);

export default eslintConfig;
