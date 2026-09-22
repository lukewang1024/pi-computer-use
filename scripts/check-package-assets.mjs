#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { helperSourceRelativePaths, resolveHelperSourcePaths } from "./setup-helper.mjs";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.deepEqual(
	resolveHelperSourcePaths(rootDir).map((sourcePath) => path.relative(rootDir, sourcePath).split(path.sep).join("/")),
	helperSourceRelativePaths,
	"the real LOCAL_BUILD source path resolver must map exactly to the package's complete Swift source manifest",
);
const expected = [
	...await listFiles(path.join(rootDir, "prebuilt"), "prebuilt"),
	...helperSourceRelativePaths,
].map((file) => `package/${file}`);

const suppliedTarball = process.argv[2];
const tarball = suppliedTarball ?? await createTarball();
try {
	const { stdout } = await execFileAsync("tar", ["-tzf", tarball], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
	const files = new Set(stdout.split("\n").filter(Boolean));
	for (const file of expected) assert.ok(files.has(file), `npm package is missing ${file}`);
} finally {
	if (!suppliedTarball) await rm(tarball, { force: true });
}
console.log("package assets passed");

async function createTarball() {
	const { stdout } = await execFileAsync("npm", ["pack", "--ignore-scripts", "--silent"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
	const filename = stdout.trim().split("\n").reverse().find((line) => line.endsWith(".tgz"));
	assert.ok(filename, "npm pack did not produce a tarball");
	return filename;
}

async function listFiles(directory, prefix) {
	const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	const files = [];
	for (const entry of entries) {
		const relativePath = path.posix.join(prefix, entry.name);
		if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relativePath));
		else if (entry.isFile()) files.push(relativePath);
	}
	return files;
}
