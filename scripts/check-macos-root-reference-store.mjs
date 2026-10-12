import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const sources = ["native/macos/root_reference_store.swift", "scripts/macos-root-reference-store-tests.swift"].map(p => path.join(root, p));
for (const source of sources) if (!fs.statSync(source).isFile()) throw new Error("Missing root reference regression source");
if (process.platform !== "darwin") {
    console.log("SKIP native root reference regressions: requires Swift on macOS");
} else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cu-root-reference-tests-"));
    try {
        const binary = path.join(dir, "tests");
        execFileSync("xcrun", ["swiftc", "-parse-as-library", ...sources, "-o", binary], { stdio: "inherit" });
        execFileSync(binary, [], { stdio: "inherit" });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
