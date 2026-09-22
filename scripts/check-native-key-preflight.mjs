import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../native/macos/bridge.swift", import.meta.url), "utf8");
const actStart = source.indexOf("private func act(_ request:");
const keyValidation = source.indexOf("normalizedMacKeypressKeys(params[\"keys\"]", actStart);
const lookLookup = source.indexOf("lookRecord(for: lookId)", actStart);
const rootObserver = source.indexOf("ensureRootObserver(pid: pid)", actStart);
assert(actStart >= 0 && keyValidation > actStart, "native act must validate keypress parameters at entry");
assert(keyValidation < lookLookup && keyValidation < rootObserver, "native key validation must precede native observation and input side effects");

const batchStart = source.indexOf("private func actBatch(_ request:");
const batchValidation = source.indexOf("normalizedMacKeypressKeys(params[\"keys\"]", batchStart);
const batchObserver = source.indexOf("ensureRootObserver(pid: pid)", batchStart);
assert(batchStart >= 0 && batchValidation > batchStart && batchValidation < batchObserver, "native batch must validate all keypresses before starting batch execution");

assert(source.includes("case \"cmd\", \"command\", \"meta\": return \"cmd\""), "native Command aliases must be normalized without dropping supported names");
assert(source.includes("private func normalizedMacChordToken"), "native plus-delimited chord validation must remain available");
assert(source.includes("private func isSupportedMacBaseKey"), "native base-key validation must be explicit");
console.log("native key preflight placement checks passed");
