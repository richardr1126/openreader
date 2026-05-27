import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const LOGGER_LEVEL_METHOD = "trace|debug|info|warn|error|fatal";
const STATIC_LOGGER_CALL_SELECTOR =
  `CallExpression[callee.type='MemberExpression'][callee.computed=false][callee.property.name=/^(${LOGGER_LEVEL_METHOD})$/]`;
const DYNAMIC_LOGGER_CALL_SELECTOR =
  "CallExpression[callee.type='MemberExpression'][callee.computed=true]";
const LOGGER_RECEIVER_SELECTOR =
  ":matches([callee.object.name=/^(logger|serverLogger)$/],[callee.object.property.name='logger'])";
const SERVER_LOGGER_CALL_SELECTOR = `:matches(${STATIC_LOGGER_CALL_SELECTOR}${LOGGER_RECEIVER_SELECTOR},${DYNAMIC_LOGGER_CALL_SELECTOR}${LOGGER_RECEIVER_SELECTOR})`;

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
      "no-restricted-syntax": [
        "error",
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR}[arguments.length<2]`,
          message:
            "Server logger calls must pass context + message: logger.<level>({ event, ...ctx }, 'message').",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR}[arguments.0.type='Literal']`,
          message:
            "Server logger first argument must be an object with an event field, not a string literal.",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR}[arguments.0.type='TemplateLiteral']`,
          message:
            "Server logger first argument must be an object with an event field, not a template string.",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR}[arguments.0.type='ObjectExpression']:not(:has(Property[key.name='event']))`,
          message:
            "Server logger context object must include an event field.",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR} > ObjectExpression:first-child > Property[key.name='err']`,
          message:
            "Use `error` (typically from errorToLog(...)) instead of `err` in server logs.",
        },
      ],
    },
  },
];

export default eslintConfig;
