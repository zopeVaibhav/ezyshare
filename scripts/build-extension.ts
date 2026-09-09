import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist", "extension");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

execFileSync("bunx", ["tsc", "-p", path.join(root, "extension", "tsconfig.json")], {
    stdio: "inherit",
    cwd: root,
});

const assets = ["manifest.json", "sidepanel.html", "sidepanel.css"];
for (const asset of assets) {
    fs.copyFileSync(path.join(root, "extension", asset), path.join(out, asset));
}
fs.cpSync(path.join(root, "extension", "icons"), path.join(out, "icons"), { recursive: true });

console.log(`built ${path.relative(root, out)}`);
