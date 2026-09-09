import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const strict = {
    eqeqeq: ["error", "always"],
    "no-var": "error",
    "prefer-const": "error",
    "no-implicit-coercion": ["error", { boolean: false }],
    "no-throw-literal": "error",
    "no-console": "off",
    "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
    ],
    "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
    "@typescript-eslint/no-explicit-any": "error",
};

export default tseslint.config(
    { ignores: ["node_modules/**", "dist/**", "coverage/**"] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["daemon/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
        languageOptions: {
            globals: globals.node,
            parserOptions: { projectService: false },
        },
        rules: strict,
    },
    {
        files: ["extension/src/**/*.ts"],
        languageOptions: {
            globals: { ...globals.browser, ...globals.webextensions },
        },
        rules: strict,
    },
    eslintConfigPrettier,
);
