import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@openreader/compute-core/*",
                "!@openreader/compute-core/local-runtime",
                "!@openreader/compute-core/types",
                "!@openreader/compute-core/api-contracts",
              ],
              message:
                "Use '@openreader/compute-core' root imports for light APIs. Allowed subpaths are '@openreader/compute-core/local-runtime', '@openreader/compute-core/types', and '@openreader/compute-core/api-contracts'.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/api/**/*.ts", "src/lib/server/**/*.ts"],
    rules: {
      "no-console": "error",
    },
  },
];

export default eslintConfig;
