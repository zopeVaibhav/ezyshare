import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

const strict = {
    eqeqeq: ["error", "always"],
    "no-var": "error",
    "prefer-const": "error",
    "no-implicit-coercion": ["error", { boolean: false }],
    "no-throw-literal": "error",
    "no-return-await": "error",
    "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    "no-console": "off",
};

export default [
    { ignores: ["node_modules/**", "coverage/**"] },
    js.configs.recommended,
    {
        files: ["daemon/**/*.mjs"],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: "module",
            globals: globals.node,
        },
        rules: strict,
    },
    {
        files: ["extension/**/*.js"],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: "module",
            globals: { ...globals.browser, ...globals.webextensions },
        },
        rules: strict,
    },
    eslintConfigPrettier,
];
