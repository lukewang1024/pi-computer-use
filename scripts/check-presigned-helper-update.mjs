import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installLocalHelperBinary, installPrebuiltHelperApp, parseDesignatedRequirement, shouldUseLocalMacBuild } from "./setup-helper.mjs";

assert.equal(
	parseDesignatedRequirement('Executable=bridge\ndesignated => identifier "com.example.helper" and anchor apple generic\n'),
	'identifier "com.example.helper" and anchor apple generic',
	"the designated requirement parser should extract the full requirement",
);
assert.throws(() => parseDesignatedRequirement("no requirement here"), /did not report a designated requirement/);
assert.equal(shouldUseLocalMacBuild([], {}), false, "local compilation must not be an implicit fallback");
assert.equal(shouldUseLocalMacBuild([], { PI_COMPUTER_USE_LOCAL_BUILD: "1" }), true);
assert.equal(shouldUseLocalMacBuild(["node", "setup-helper.mjs", "--local-build"], {}), true);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-presigned-test-"));
const bundleContentPath = (bundlePath, file) => path.join(bundlePath, "Contents", file);

async function writeBundle(bundlePath, { executable, info }) {
	await fs.mkdir(path.dirname(bundleContentPath(bundlePath, "MacOS/bridge")), { recursive: true });
	await fs.mkdir(path.dirname(bundleContentPath(bundlePath, "Info.plist")), { recursive: true });
	await fs.writeFile(bundleContentPath(bundlePath, "MacOS/bridge"), executable);
	await fs.writeFile(bundleContentPath(bundlePath, "Info.plist"), info);
}

async function bundleContent(bundlePath) {
	return fs.readFile(bundleContentPath(bundlePath, "MacOS/bridge"), "utf8");
}

async function bundleFingerprint(bundlePath, excludedRelativePath) {
	const hash = createHash("sha256");
	const visit = async (directory, prefix = "") => {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const relativePath = path.posix.join(prefix, entry.name);
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath, relativePath);
			} else if (relativePath !== excludedRelativePath) {
				hash.update(relativePath);
				hash.update("\0");
				hash.update(await fs.readFile(entryPath));
			}
		}
	};
	await visit(bundlePath);
	return hash.digest("hex");
}

async function exists(filePath) {
	return fs.access(filePath).then(() => true, () => false);
}

async function options(installPath, {
	pinnedIdentity,
	identityAvailable = true,
	registerCount = { value: 0 },
	copyCount = { value: 0 },
	verifyCount = { value: 0 },
	copyBundle = async (source, destination) => fs.cp(source, destination, { recursive: true }),
} = {}) {
	return {
		installPath,
		verifySignature: async () => { verifyCount.value += 1; },
		readRequirement: async (appPath) => {
			const info = await fs.readFile(bundleContentPath(appPath, "Info.plist"), "utf8");
			return info.match(/DR=(.+)/)?.[1];
		},
		readPinnedIdentity: async () => pinnedIdentity,
		checkIdentityAvailable: async () => identityAvailable,
		copyBundle: async (source, destination) => {
			copyCount.value += 1;
			await copyBundle(source, destination);
		},
		register: async () => { registerCount.value += 1; },
		lockOptions: { waitMs: 5_000, staleMs: 0, retryMs: 5 },
		registerCount,
		copyCount,
		verifyCount,
	};
}

function crashInstaller({ installPath, sourcePath, hook }) {
	const moduleUrl = pathToFileURL(path.resolve("scripts/setup-helper.mjs")).href;
	const program = `
import fs from "node:fs/promises";
const { installPrebuiltHelperApp } = await import(process.env.PI_TEST_SETUP_MODULE);
const installPath = process.env.PI_TEST_INSTALL_PATH;
const sourcePath = process.env.PI_TEST_SOURCE_PATH;
const hook = process.env.PI_TEST_CRASH_HOOK;
const readRequirement = async (appPath) => {
  const info = await fs.readFile(appPath + "/Contents/Info.plist", "utf8");
  return info.match(/DR=(.+)/)?.[1];
};
await installPrebuiltHelperApp(sourcePath, {
  installPath,
  verifySignature: async () => {},
  readRequirement,
  readPinnedIdentity: async () => undefined,
  checkIdentityAvailable: async () => true,
  copyBundle: (source, destination) => fs.cp(source, destination, { recursive: true }),
  register: async () => {},
  lockOptions: { waitMs: 5000, staleMs: 0, retryMs: 5 },
  [hook]: () => process.exit(hook === "afterOldBundleMoved" ? 77 : 78),
});
`;
	return spawnSync(process.execPath, ["--input-type=module", "-e", program], {
		encoding: "utf8",
		env: {
			...process.env,
			PI_TEST_SETUP_MODULE: moduleUrl,
			PI_TEST_INSTALL_PATH: installPath,
			PI_TEST_SOURCE_PATH: sourcePath,
			PI_TEST_CRASH_HOOK: hook,
		},
	});
}

try {
	const installedPath = path.join(tempDir, "pi-computer-use.app");
	const sourcePath = path.join(tempDir, "candidate.app");
	const oldInfo = "Version=1\nDR=DR-A\n";
	const newInfo = "Version=2\nDR=DR-A\n";
	await writeBundle(installedPath, { executable: "same executable", info: oldInfo });
	await writeBundle(sourcePath, { executable: "same executable", info: oldInfo });
	const firstStable = await options(installedPath);
	assert.equal(await installPrebuiltHelperApp(sourcePath, firstStable), false, "identical signed helper should be a no-op");
	assert.equal(await installPrebuiltHelperApp(sourcePath, firstStable), false, "repeated setup with the same identity should remain a no-op");
	assert.equal(firstStable.copyCount.value, 0, "stable setup must not copy or re-sign a helper");

	await writeBundle(sourcePath, { executable: "different executable", info: newInfo.replace("DR-A", "DR-B") });
	const mismatchOptions = await options(installedPath);
	await assert.rejects(
		installPrebuiltHelperApp(sourcePath, mismatchOptions),
		(error) => error.code === "ERR_HELPER_IDENTITY_MISMATCH",
		"a different designated requirement must be rejected",
	);
	assert.equal(await bundleContent(installedPath), "same executable", "identity mismatch must preserve the installed bundle");
	assert.equal(mismatchOptions.copyCount.value, 0, "identity mismatch must fail before staging a replacement");
	assert.equal(mismatchOptions.registerCount.value, 0, "identity mismatch must not alter LaunchServices registration");

	await writeBundle(sourcePath, { executable: "updated executable", info: newInfo });
	const updateOptions = await options(installedPath);
	assert.equal(await installPrebuiltHelperApp(sourcePath, updateOptions), true, "same-DR update should install");
	assert.equal(await bundleContent(installedPath), "updated executable");
	assert.ok(updateOptions.verifyCount.value >= 5, "the source, previous, staged, installed and retained bundles are verified");
	assert.equal(updateOptions.registerCount.value, 1, "successful update registers the new installed bundle");
	assert.deepEqual((await fs.readdir(tempDir)).sort(), ["candidate.app", "pi-computer-use.app"], "successful update should clean transaction files and bundles");

	await writeBundle(installedPath, { executable: "installed remains", info: oldInfo });
	await writeBundle(sourcePath, { executable: "candidate update", info: newInfo });
	const missingPinOptions = await options(installedPath, { pinnedIdentity: "A".repeat(40), identityAvailable: false });
	await assert.rejects(
		installPrebuiltHelperApp(sourcePath, missingPinOptions),
		(error) => error.code === "ERR_PINNED_HELPER_IDENTITY_UNAVAILABLE",
		"a missing pinned certificate must fail clearly",
	);
	assert.equal(await bundleContent(installedPath), "installed remains", "missing pinned certificate must preserve the old helper");
	assert.equal(missingPinOptions.copyCount.value, 0, "missing pinned certificate must fail before staging");

	const failOnInstallRename = {
		...fs,
		async rename(source, destination) {
			if (source.includes(".staging-") && destination === installedPath) throw new Error("injected staged rename failure");
			return fs.rename(source, destination);
		},
	};
	const rollbackOptions = await options(installedPath);
	rollbackOptions.fileSystem = failOnInstallRename;
	await assert.rejects(installPrebuiltHelperApp(sourcePath, rollbackOptions), /injected staged rename failure/);
	assert.equal(await bundleContent(installedPath), "installed remains", "failed staged replacement must roll back to the previous bundle");
	assert.deepEqual((await fs.readdir(tempDir)).sort(), ["candidate.app", "pi-computer-use.app"], "failed update should clean transaction files and restore the old bundle");

	const missingInstallPath = path.join(tempDir, "missing.app");
	const missingInstalledWithPin = await options(missingInstallPath, { pinnedIdentity: "B".repeat(40) });
	await assert.rejects(
		installPrebuiltHelperApp(sourcePath, missingInstalledWithPin),
		(error) => error.code === "ERR_PINNED_HELPER_IDENTITY_UNVERIFIABLE",
		"a configured pin without an installed bundle must not silently accept a replacement identity",
	);
	assert.equal(await exists(missingInstallPath), false, "missing installed app must remain missing on pin failure");

	// process.exit bypasses installer catch/finally, modelling an actual process
	// interruption after the official path has moved away.
	const movedPath = path.join(tempDir, "crash-after-old-move.app");
	const movedSource = path.join(tempDir, "crash-candidate.app");
	await writeBundle(movedPath, { executable: "old recoverable", info: oldInfo });
	await writeBundle(movedSource, { executable: "new recoverable", info: newInfo });
	const oldMoveCrash = crashInstaller({ installPath: movedPath, sourcePath: movedSource, hook: "afterOldBundleMoved" });
	assert.equal(oldMoveCrash.status, 77, `child must exit at the old-moved fault point: ${oldMoveCrash.stderr}`);
	assert.equal(await exists(movedPath), false, "injected process interruption must leave the official path absent");
	const movedManifestPath = `${movedPath}.update-transaction.json`;
	const movedManifest = JSON.parse(await fs.readFile(movedManifestPath, "utf8"));
	assert.equal(await exists(movedManifest.backupPath), true, "the exact recorded backup should hold the old app after interruption");
	let pinSawRestoredOld = false;
	const retryWithUnavailablePin = await options(movedPath, { pinnedIdentity: "C".repeat(40), identityAvailable: false });
	retryWithUnavailablePin.readPinnedIdentity = async () => {
		pinSawRestoredOld = await exists(movedPath) && await bundleContent(movedPath) === "old recoverable";
		return "C".repeat(40);
	};
	await assert.rejects(
		installPrebuiltHelperApp(movedSource, retryWithUnavailablePin),
		(error) => error.code === "ERR_PINNED_HELPER_IDENTITY_UNAVAILABLE",
		"recovery must finish before the normal pin guard runs",
	);
	assert.equal(pinSawRestoredOld, true, "setup must restore and validate the old app before checking the pin");
	assert.equal(await bundleContent(movedPath), "old recoverable", "the missing official path must be restored from its exact backup");
	assert.equal(await exists(movedManifestPath), false, "successful recovery must clear its transaction record");
	const retryUpdateOptions = await options(movedPath);
	assert.equal(await installPrebuiltHelperApp(movedSource, retryUpdateOptions), true, "setup should be retryable after a crash recovery");
	assert.equal(await bundleContent(movedPath), "new recoverable");

	// A real exit after the replacement is installed leaves the manifest and old
	// backup behind. The next setup verifies both, then finishes cleanup.
	const installedCrashPath = path.join(tempDir, "crash-after-new-install.app");
	const installedCrashSource = path.join(tempDir, "installed-crash-candidate.app");
	await writeBundle(installedCrashPath, { executable: "old before cleanup", info: oldInfo });
	await writeBundle(installedCrashSource, { executable: "new before cleanup", info: newInfo });
	const newInstallCrash = crashInstaller({ installPath: installedCrashPath, sourcePath: installedCrashSource, hook: "afterNewBundleInstalled" });
	assert.equal(newInstallCrash.status, 78, `child must exit at the new-installed fault point: ${newInstallCrash.stderr}`);
	const installedManifest = JSON.parse(await fs.readFile(`${installedCrashPath}.update-transaction.json`, "utf8"));
	assert.equal(await bundleContent(installedCrashPath), "new before cleanup");
	assert.equal(await exists(installedManifest.backupPath), true, "old backup must remain until candidate verification and recovery");
	assert.equal(await installPrebuiltHelperApp(installedCrashSource, await options(installedCrashPath)), false, "retry should recognize and retain the already installed candidate");
	assert.equal(await exists(installedManifest.backupPath), false, "verified duplicate backup should be cleaned on retry");
	assert.equal(await exists(`${installedCrashPath}.update-transaction.json`), false, "retry should clear the completed transaction");

	// Tampered recovery metadata must fail closed and preserve the only old app.
	const mismatchRecoveryPath = path.join(tempDir, "mismatched-recovery.app");
	const mismatchRecoverySource = path.join(tempDir, "mismatch-recovery-candidate.app");
	await writeBundle(mismatchRecoveryPath, { executable: "only valid old app", info: oldInfo });
	await writeBundle(mismatchRecoverySource, { executable: "candidate in recovery", info: newInfo });
	const mismatchRecoveryCrash = crashInstaller({ installPath: mismatchRecoveryPath, sourcePath: mismatchRecoverySource, hook: "afterOldBundleMoved" });
	assert.equal(mismatchRecoveryCrash.status, 77, `child must exit before recovery metadata is changed: ${mismatchRecoveryCrash.stderr}`);
	const mismatchManifestPath = `${mismatchRecoveryPath}.update-transaction.json`;
	const mismatchManifest = JSON.parse(await fs.readFile(mismatchManifestPath, "utf8"));
	mismatchManifest.previous.bundleSha256 = "0".repeat(64);
	await fs.writeFile(mismatchManifestPath, `${JSON.stringify(mismatchManifest, null, 2)}\n`);
	let mismatchPinReads = 0;
	const mismatchRecoveryOptions = await options(mismatchRecoveryPath);
	mismatchRecoveryOptions.readPinnedIdentity = async () => { mismatchPinReads += 1; return undefined; };
	await assert.rejects(
		installPrebuiltHelperApp(mismatchRecoverySource, mismatchRecoveryOptions),
		(error) => error.code === "ERR_HELPER_UPDATE_RECOVERY_MISMATCH",
		"a backup that disagrees with the recovery record must be refused",
	);
	assert.equal(mismatchPinReads, 0, "recovery metadata must be checked before ordinary pin evaluation");
	assert.equal(await exists(mismatchRecoveryPath), false, "mismatched recovery data must not move the unverified backup");
	assert.equal(await exists(mismatchManifest.backupPath), true, "mismatched recovery data must preserve the only old bundle");

	// The per-install lock must serialize concurrent setup attempts.
	const concurrentPath = path.join(tempDir, "concurrent-update.app");
	const concurrentSource = path.join(tempDir, "concurrent-candidate.app");
	await writeBundle(concurrentPath, { executable: "old concurrent", info: oldInfo });
	await writeBundle(concurrentSource, { executable: "new concurrent", info: newInfo });
	let activeCopies = 0;
	let maximumActiveCopies = 0;
	const slowCopy = async (source, destination) => {
		activeCopies += 1;
		maximumActiveCopies = Math.max(maximumActiveCopies, activeCopies);
		await new Promise((resolve) => setTimeout(resolve, 60));
		await fs.cp(source, destination, { recursive: true });
		activeCopies -= 1;
	};
	const concurrentOptionsA = await options(concurrentPath, { copyBundle: slowCopy });
	const concurrentOptionsB = await options(concurrentPath, { copyBundle: slowCopy });
	concurrentOptionsA.lockOptions = { waitMs: 5_000, staleMs: 30_000, retryMs: 5 };
	concurrentOptionsB.lockOptions = { waitMs: 5_000, staleMs: 30_000, retryMs: 5 };
	await Promise.all([
		installPrebuiltHelperApp(concurrentSource, concurrentOptionsA),
		installPrebuiltHelperApp(concurrentSource, concurrentOptionsB),
	]);
	assert.equal(maximumActiveCopies, 1, "concurrent setup calls must not overlap their transaction copies");
	assert.equal(await bundleContent(concurrentPath), "new concurrent");
	assert.equal(await exists(`${concurrentPath}.update-transaction.json`), false, "serialized setup must leave no unfinished transaction");

	// Loose binaries are assembled and signed in a temporary bundle, then use
	// the same locked identity guard and recoverable installer as release apps.
	const localInstallPath = path.join(tempDir, "local-build-install.app");
	const localBinaryPath = path.join(tempDir, "local-build-binary");
	await fs.writeFile(localBinaryPath, "local binary v1");
	let localSignCount = 0;
	let localVerifyCount = 0;
	let localIdentityReadCount = 0;
	const localRegisterCount = { value: 0 };
	const localOptions = {
		installPath: localInstallPath,
		getVersion: async () => "9.9.9-test",
		resolveSigningIdentity: async () => "CERT-85EA",
		signBundle: async (appPath, identity) => {
			if (identity === "unsigned") return;
			localSignCount += 1;
			const bridgePath = path.join(appPath, "Contents", "MacOS", "bridge");
			await fs.appendFile(bridgePath, Buffer.from(`\nSIGNED:${identity}`));
			const resourcesPath = path.join(appPath, "Contents", "Resources");
			await fs.writeFile(path.join(resourcesPath, "test-designated-requirement"), identity === "CERT-85EA" ? "DR-85EA" : "DR-OTHER");
			await fs.writeFile(path.join(resourcesPath, "test-signing-identity"), identity);
			const signaturePath = path.join(resourcesPath, "test-signature.sha256");
			await fs.writeFile(signaturePath, await bundleFingerprint(appPath, "Contents/Resources/test-signature.sha256"));
		},
		verifySignature: async (appPath) => {
			localVerifyCount += 1;
			const signaturePath = path.join(appPath, "Contents", "Resources", "test-signature.sha256");
			assert.equal(await fs.readFile(signaturePath, "utf8"), await bundleFingerprint(appPath, "Contents/Resources/test-signature.sha256"),
				"stub signature verification must cover bundle contents and sealed identity metadata");
		},
		readRequirement: async (appPath) => fs.readFile(path.join(appPath, "Contents", "Resources", "test-designated-requirement"), "utf8").catch((error) => {
			if (error.code === "ENOENT") return "explicit-unsigned-development";
			throw error;
		}),
		readInstalledIdentity: async (appPath) => {
			localIdentityReadCount += 1;
			return fs.readFile(path.join(appPath, "Contents", "Resources", "test-signing-identity"), "utf8").catch(() => undefined);
		},
		readPinnedIdentity: async () => undefined,
		checkIdentityAvailable: async () => true,
		copyBundle: (source, destination) => fs.cp(source, destination, { recursive: true }),
		register: async () => { localRegisterCount.value += 1; },
		lockOptions: { waitMs: 5_000, staleMs: 0, retryMs: 5 },
	};
	const originalLocalBinary = await fs.readFile(localBinaryPath);
	assert.equal(await installLocalHelperBinary(localBinaryPath, localOptions), true, "local loose binary must install through the transaction path");
	assert.equal(localSignCount, 1);
	assert.notDeepEqual(await fs.readFile(bundleContentPath(localInstallPath, "MacOS/bridge")), originalLocalBinary,
		"the stub signer must rewrite candidate Mach-O bytes to model codesign");
	const firstInstalledLocalBundle = await bundleFingerprint(localInstallPath);
	const verificationCountBeforeStableSetup = localVerifyCount;
	const identityReadCountBeforeStableSetup = localIdentityReadCount;
	assert.equal(await installLocalHelperBinary(localBinaryPath, localOptions), false, "same-content local setup must not re-sign");
	assert.equal(localSignCount, 1, "stable local setup must not call the signer again");
	assert.equal(localVerifyCount, verificationCountBeforeStableSetup + 1, "stable setup must strictly verify the installed signature");
	assert.equal(localIdentityReadCount, identityReadCountBeforeStableSetup + 1, "stable setup must read the actual installed signer identity");
	assert.equal(await bundleFingerprint(localInstallPath), firstInstalledLocalBundle, "same-content setup must preserve every installed bundle byte");

	const localPinnedOptions = {
		...localOptions,
		readPinnedIdentity: async () => "85EA403B3A6D59ED0B0DF838D9826B90BF3FC2C9",
	};
	await fs.writeFile(localBinaryPath, "local binary v2");
	assert.equal(await installLocalHelperBinary(localBinaryPath, localPinnedOptions), true, "local build signed by the available pinned identity should upgrade the installed app");
	assert.ok((await bundleContent(localInstallPath)).startsWith("local binary v2\nSIGNED:CERT-85EA"));
	assert.equal(localSignCount, 2);

	const beforeLocalIdentityMismatch = await bundleFingerprint(localInstallPath);
	await fs.writeFile(localBinaryPath, "local binary v3");
	const localMismatchOptions = {
		...localPinnedOptions,
		resolveSigningIdentity: async () => "CERT-OTHER",
	};
	await assert.rejects(
		installLocalHelperBinary(localBinaryPath, localMismatchOptions),
		(error) => error.code === "ERR_HELPER_IDENTITY_MISMATCH",
		"a different local build identity must not replace the installed app implicitly",
	);
	assert.equal(await bundleFingerprint(localInstallPath), beforeLocalIdentityMismatch, "local DR mismatch must preserve every installed bundle byte");
	assert.equal(localSignCount, 3);

	let signerCalledWithUnavailablePin = false;
	const unavailableLocalPin = {
		...localPinnedOptions,
		readPinnedIdentity: async () => "85EA403B3A6D59ED0B0DF838D9826B90BF3FC2C9",
		checkIdentityAvailable: async () => false,
		resolveSigningIdentity: async () => { signerCalledWithUnavailablePin = true; return "CERT-OTHER"; },
	};
	await assert.rejects(
		installLocalHelperBinary(localBinaryPath, unavailableLocalPin),
		(error) => error.code === "ERR_PINNED_HELPER_IDENTITY_UNAVAILABLE",
		"a missing local pin must fail before signing or replacing the old app",
	);
	assert.equal(signerCalledWithUnavailablePin, false);
	assert.equal(await bundleFingerprint(localInstallPath), beforeLocalIdentityMismatch);

	const explicitUnsignedOptions = {
		...localPinnedOptions,
		resolveSigningIdentity: async () => "unsigned",
	};
	await assert.rejects(
		installLocalHelperBinary(localBinaryPath, explicitUnsignedOptions),
		/Refusing to replace an installed helper with an unsigned local build/,
		"unsigned local migration must retain its explicit development gate",
	);
	assert.equal(await bundleFingerprint(localInstallPath), beforeLocalIdentityMismatch);
	assert.equal(await installLocalHelperBinary(localBinaryPath, { ...explicitUnsignedOptions, allowAdhocIdentityUpdate: true }), true,
		"the established explicit ad-hoc development option must keep working through the transaction installer");
	assert.equal(await bundleContent(localInstallPath), "local binary v3");

	console.log("[check-presigned-helper-update] presigned and local build identity guards, retryable transaction, process-crash recovery, mismatch refusal, and concurrent setup passed");
} finally {
	await fs.rm(tempDir, { recursive: true, force: true });
}
