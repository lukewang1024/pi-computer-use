#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLocalMacBuildInput, installLocalMacBuild } from "./setup-helper.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-build-input-test-"));
const installPath = path.join(tempDir, "pi-computer-use.app");
const repositoryRoot = path.join(tempDir, "repo");
const sourcePath = path.join(repositoryRoot, "native", "macos", "bridge.swift");
const installerRulesPath = path.join(repositoryRoot, "scripts", "setup-helper.mjs");
const signingIdentity = "85EA403B3A6D59ED0B0DF838D9826B90BF3FC2C9";
const designatedRequirement = `identifier "com.injaneity.pi-computer-use" and certificate leaf = H"${signingIdentity}"`;
const toolchainIdentity = {
	swiftcPath: "/Xcode/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc",
	swiftcVersion: "Apple Swift version 6.2.1",
	developerDirectory: "/Xcode",
	sdkPath: "/Xcode/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
	sdkVersion: "15.7",
	sdkBuildVersion: "24G90",
};
let compilerArgs = ["swiftc", "-target", "arm64-apple-macosx14.0", "-O", "bridge.swift", "-o", "<OUTPUT>"];
let compileCount = 0;
let signCount = 0;
let verifyCount = 0;

function bundlePath(bundlePath, relativePath) {
	return path.join(bundlePath, "Contents", relativePath);
}

async function bundleDigest(bundlePath) {
	const hash = createHash("sha256");
	async function visit(currentPath, relativePath = "") {
		const entries = await fs.readdir(currentPath, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const childPath = path.join(currentPath, entry.name);
			const childRelativePath = path.posix.join(relativePath, entry.name);
			if (entry.isDirectory()) {
				await visit(childPath, childRelativePath);
			} else if (childRelativePath !== "Contents/Resources/test-signature.sha256") {
				hash.update(childRelativePath);
				hash.update("\0");
				hash.update(await fs.readFile(childPath));
			}
		}
	}
	await visit(bundlePath);
	return hash.digest("hex");
}

async function signBundle(bundlePath, identity) {
	signCount += 1;
	const resourcesPath = bundlePath + "/Contents/Resources";
	await fs.writeFile(path.join(resourcesPath, "test-designated-requirement"), designatedRequirement);
	await fs.writeFile(path.join(resourcesPath, "test-signing-identity"), identity);
	await fs.writeFile(path.join(resourcesPath, "test-signature.sha256"), await bundleDigest(bundlePath));
}

async function verifySignature(bundlePath) {
	verifyCount += 1;
	const expected = await fs.readFile(bundlePath + "/Contents/Resources/test-signature.sha256", "utf8");
	assert.equal(expected, await bundleDigest(bundlePath), "stub strict signature covers the complete bundle metadata");
}

async function writeSignedInstalledBundle() {
	await fs.mkdir(bundlePath(installPath, "Resources"), { recursive: true });
	await fs.mkdir(bundlePath(installPath, "MacOS"), { recursive: true });
	await fs.writeFile(bundlePath(installPath, "Info.plist"), "old app metadata\n");
	await fs.writeFile(bundlePath(installPath, "MacOS/bridge"), "previously installed executable\n");
	await fs.writeFile(bundlePath(installPath, "Resources/source.sha256"), "previous-source\n");
	await fs.writeFile(bundlePath(installPath, "Resources/signing-identity.sha1"), `${signingIdentity}\n`);
	await signBundle(installPath, signingIdentity);
}

const buildInputProvider = (arch, options) => createLocalMacBuildInput(arch, {
	...options,
	sourcePaths: [sourcePath],
	repositoryRoot,
	compilerArgs,
	toolchainIdentity,
	installerRulesPath,
});

const setupOptions = {
	arch: "arm64",
	installPath,
	getVersion: async () => "0.5.2",
	resolveSigningIdentity: async () => signingIdentity,
	readPinnedIdentity: async () => signingIdentity,
	checkIdentityAvailable: async () => true,
	readRequirement: async (appPath) => fs.readFile(bundlePath(appPath, "Resources/test-designated-requirement"), "utf8"),
	readInstalledIdentity: async (appPath) => fs.readFile(bundlePath(appPath, "Resources/test-signing-identity"), "utf8").catch(() => undefined),
	verifySignature,
	signBundle,
	copyBundle: (source, destination) => fs.cp(source, destination, { recursive: true }),
	register: async () => {},
	buildInputProvider,
	compileHelper: async (_arch, outputPath) => {
		compileCount += 1;
		await fs.writeFile(outputPath, `stub compiler output ${compileCount}\n`);
	},
	lockOptions: { waitMs: 5_000, staleMs: 0, retryMs: 5 },
};

try {
	await fs.mkdir(path.dirname(sourcePath), { recursive: true });
	await fs.mkdir(path.dirname(installerRulesPath), { recursive: true });
	await fs.writeFile(sourcePath, "struct Bridge {}\n");
	await fs.writeFile(installerRulesPath, "installer rules v1\n");
	await writeSignedInstalledBundle();

	assert.equal(await installLocalMacBuild(setupOptions), true, "first LOCAL_BUILD invocation should compile and transactionally install");
	assert.equal(compileCount, 1);
	assert.equal(signCount, 2, "initial fixture signing plus candidate signing");
	const firstBundleDigest = await bundleDigest(installPath);
	const firstInputSeal = JSON.parse(await fs.readFile(bundlePath(installPath, "Resources/local-build-input.json"), "utf8"));
	assert.match(firstInputSeal.fingerprint, /^[0-9a-f]{64}$/);
	assert.equal((await fs.readFile(bundlePath(installPath, "Resources/source.sha256"), "utf8")).trim(), createHash("sha256").update(await fs.readFile(bundlePath(installPath, "MacOS/bridge"))).digest("hex"),
		"the established source.sha256 record remains in the built bundle");

	const verifiesBeforeSecondBuild = verifyCount;
	assert.equal(await installLocalMacBuild(setupOptions), false, "second identical LOCAL_BUILD should report already-current");
	assert.equal(compileCount, 1, "matching sealed build inputs must skip the compiler");
	assert.equal(signCount, 2, "matching sealed build inputs must skip signing");
	assert.equal(verifyCount, verifiesBeforeSecondBuild + 1, "the already-current path strictly verifies the installed signature");
	assert.equal(await bundleDigest(installPath), firstBundleDigest, "already-current must preserve every bundle byte");

	compilerArgs = [...compilerArgs, "-D", "CHANGED_COMPILER_FLAG"];
	assert.equal(await installLocalMacBuild(setupOptions), true, "a compiler flag change must rebuild");
	assert.equal(compileCount, 2);
	assert.equal(signCount, 3);
	const secondInputSeal = JSON.parse(await fs.readFile(bundlePath(installPath, "Resources/local-build-input.json"), "utf8"));
	assert.notEqual(secondInputSeal.fingerprint, firstInputSeal.fingerprint);

	await fs.writeFile(sourcePath, "struct Bridge { let changed = true }\n");
	assert.equal(await installLocalMacBuild(setupOptions), true, "a Swift source content change must rebuild");
	assert.equal(compileCount, 3);
	assert.equal(signCount, 4);
	const thirdInputSeal = JSON.parse(await fs.readFile(bundlePath(installPath, "Resources/local-build-input.json"), "utf8"));
	assert.notEqual(thirdInputSeal.fingerprint, secondInputSeal.fingerprint);

	console.log("[check-local-build-fingerprint] LOCAL_BUILD skips repeated compile/sign only for the strictly verified pinned bundle and rebuilds for compiler/source changes");
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
}
