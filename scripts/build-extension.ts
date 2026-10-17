import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist", "extension");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/*
    bun build rather than tsc, because the panel imports npm packages and tsc only
    transpiles. Types are still checked separately by `bun run typecheck`.
*/
execFileSync(
    "bun",
    [
        "build",
        path.join(root, "extension", "src", "background.ts"),
        path.join(root, "extension", "src", "sidepanel.ts"),
        "--outdir",
        out,
        "--target",
        "browser",
        "--format",
        "esm",
        "--minify",
    ],
    { stdio: "inherit", cwd: root },
);

const assets = ["manifest.json", "sidepanel.html", "sidepanel.css"];
for (const asset of assets) {
    fs.copyFileSync(path.join(root, "extension", asset), path.join(out, asset));
}
fs.cpSync(path.join(root, "extension", "icons"), path.join(out, "icons"), { recursive: true });

/*
    Only the latin subsets are copied. An extension has to carry its fonts, and the other
    subsets would triple the payload for glyphs a peer name will not use.
*/
const fonts = [
    ["@fontsource-variable/plus-jakarta-sans", "plus-jakarta-sans-latin-wght-normal.woff2"],
] as const;

const fontsOut = path.join(out, "fonts");
fs.mkdirSync(fontsOut, { recursive: true });

for (const [pkg, file] of fonts) {
    fs.copyFileSync(path.join(root, "node_modules", pkg, "files", file), path.join(fontsOut, file));
    fs.copyFileSync(
        path.join(root, "node_modules", pkg, "LICENSE"),
        path.join(fontsOut, `${pkg.split("/")[1]}-LICENSE`),
    );
}

console.log(`built ${path.relative(root, out)}`);
