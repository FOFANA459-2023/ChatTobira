import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "path";
import { fileURLToPath } from "url";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "next-env.d.ts",
      ".next/**",
      ".open-next/**",
      ".wrangler/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
];

export default config;
