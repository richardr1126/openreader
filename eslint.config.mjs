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
const NEXT_RESPONSE_ERROR_JSON_SELECTOR =
  "CallExpression[callee.type='MemberExpression'][callee.object.name='NextResponse'][callee.property.name='json'][arguments.0.type='ObjectExpression']:has(Property[key.name='error'])";
const APP_DESIGN_SYSTEM_FILES = [
  "src/app/(app)/**/*.{ts,tsx}",
  "src/components/**/*.{ts,tsx}",
];
const UI_ARCHITECTURE_FILES = [
  "src/app/(app)/**/*.{ts,tsx}",
  "src/components/auth/**/*.{ts,tsx}",
  "src/components/doclist/**/*.{ts,tsx}",
  "src/components/documents/DocumentUploader.tsx",
  "src/components/documents/DocumentSelectionModal.tsx",
  "src/components/documents/DexieMigrationModal.tsx",
  "src/components/documents/ZoomControl.tsx",
  "src/components/player/**/*.{ts,tsx}",
  "src/components/reader/**/*.{ts,tsx}",
];
const COMPUTE_CORE_IMPORT_PATTERNS = [
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
];
const UI_ARCHITECTURE_IMPORT_PATHS = [
  {
    name: "@/components/formPrimitives",
    message:
      "Use '@/components/ui' primitives; formPrimitives has been removed.",
  },
  {
    name: "@/components/ui/buttonPrimitives",
    message:
      "Use '@/components/ui' button exports; buttonPrimitives has been removed.",
  },
  {
    name: "@headlessui/react",
    importNames: ["Button", "Input"],
    message:
      "Use app UI Button/Input primitives; Headless UI should be reserved for structural primitives such as Menu, Listbox, Popover, Dialog, and Transition.",
  },
];
const RESTRICTED_APP_CLASS_PATTERNS = [
  {
    selector: "Literal[value=/(bg|text|border|ring)-(gray|slate|zinc|neutral|stone|red|orange|yellow|amber|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d/]",
    message:
      "Use semantic design-system tokens instead of literal Tailwind palette color classes in app surfaces.",
  },
  {
    selector: "TemplateElement[value.raw=/(bg|text|border|ring)-(gray|slate|zinc|neutral|stone|red|orange|yellow|amber|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d/]",
    message:
      "Use semantic design-system tokens instead of literal Tailwind palette color classes in app surfaces.",
  },
  {
    selector: "Literal[value=/transition-all/]",
    message:
      "Use scoped transition utilities; transition-all is banned by the app design system.",
  },
  {
    selector: "TemplateElement[value.raw=/transition-all/]",
    message:
      "Use scoped transition utilities; transition-all is banned by the app design system.",
  },
  {
    selector: "Literal[value=/(bg|text|border|from|via|to)-(accent|background|foreground|base|offbase|muted|secondary-accent|surface|surface-solid|surface-sunken|line|line-soft|line-strong|soft|faint|accent-wash|accent-line|accent-strong|danger|danger-wash)\\/\\d/]",
    message:
      "Do not use Tailwind alpha modifiers on theme-token colors; use dedicated wash/semantic tokens.",
  },
  {
    selector: "TemplateElement[value.raw=/(bg|text|border|from|via|to)-(accent|background|foreground|base|offbase|muted|secondary-accent|surface|surface-solid|surface-sunken|line|line-soft|line-strong|soft|faint|accent-wash|accent-line|accent-strong|danger|danger-wash)\\/\\d/]",
    message:
      "Do not use Tailwind alpha modifiers on theme-token colors; use dedicated wash/semantic tokens.",
  },
  {
    selector: "Literal[value=/rounded-\\[[^\\]]*px\\]/]",
    message:
      "Use the app radius scale instead of arbitrary rounded-[…px] utilities.",
  },
  {
    selector: "TemplateElement[value.raw=/rounded-\\[[^\\]]*px\\]/]",
    message:
      "Use the app radius scale instead of arbitrary rounded-[…px] utilities.",
  },
  {
    selector: "Literal[value=/duration-\\[[^\\]]*ms\\]/]",
    message:
      "Use the shared motion duration tokens instead of arbitrary duration-[…ms] utilities.",
  },
  {
    selector: "TemplateElement[value.raw=/duration-\\[[^\\]]*ms\\]/]",
    message:
      "Use the shared motion duration tokens instead of arbitrary duration-[…ms] utilities.",
  },
];

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: COMPUTE_CORE_IMPORT_PATTERNS,
        },
      ],
    },
  },
  {
    files: APP_DESIGN_SYSTEM_FILES,
    rules: {
      "no-restricted-syntax": ["error", ...RESTRICTED_APP_CLASS_PATTERNS],
    },
  },
  {
    files: UI_ARCHITECTURE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: UI_ARCHITECTURE_IMPORT_PATHS,
          patterns: COMPUTE_CORE_IMPORT_PATTERNS,
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
          selector: `${SERVER_LOGGER_CALL_SELECTOR}[arguments.0.type!='ObjectExpression']`,
          message:
            "Server logger first argument must be an object with an event field.",
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
          selector: `${SERVER_LOGGER_CALL_SELECTOR}[arguments.1.type!='Literal'][arguments.1.type!='TemplateLiteral']`,
          message:
            "Server logger second argument must be a message string (literal or template literal).",
        },
        {
          selector: `${STATIC_LOGGER_CALL_SELECTOR}[callee.property.name='error']${LOGGER_RECEIVER_SELECTOR}[arguments.0.type='ObjectExpression']:not(:has(ObjectExpression > Property[key.name='error'])):not(:has(ObjectExpression > SpreadElement))`,
          message:
            "Error-level server logger calls must include nested `error` payload (prefer `error: errorToLog(...)`).",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR} > ObjectExpression:first-child > Property[key.name='detail']`,
          message:
            "Do not use top-level `detail` in server logger context; keep throwable text under `error.message`.",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR} > ObjectExpression:first-child > Property[key.name='errorCode']`,
          message:
            "Do not use top-level `errorCode` in server logger context; classify failures under nested `error.code`.",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR} > ObjectExpression:first-child > Property[key.name='err']`,
          message:
            "Use `error` (typically from errorToLog(...)) instead of `err` in server logs.",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR} > ObjectExpression:first-child > Property[key.name='error'][value.type='Literal']`,
          message:
            "Server logger `error` must be a structured object (prefer `errorToLog(...)`), not a literal.",
        },
        {
          selector: `${SERVER_LOGGER_CALL_SELECTOR} > ObjectExpression:first-child > Property[key.name='error'][value.type='TemplateLiteral']`,
          message:
            "Server logger `error` must be a structured object (prefer `errorToLog(...)`), not template text.",
        },
        {
          selector: `CatchClause ReturnStatement > ${NEXT_RESPONSE_ERROR_JSON_SELECTOR}[arguments.1.type='ObjectExpression']:has(Property[key.name='status'][value.value=500])`,
          message:
            "Use shared error response helpers (e.g. errorResponse(...)) for terminal 500 route failures instead of direct NextResponse.json({ error }).",
        },
      ],
    },
  },
];

export default eslintConfig;
