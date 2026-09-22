#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants, createWriteStream, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMacosHelperAppPath } from "../src/platform/macos/helper-path.mjs";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperAppPath = resolveMacosHelperAppPath();
const helperBundleId = "com.injaneity.pi-computer-use";
const windowsCrateDir = path.join(rootDir, "native", "windows", "bridge-rs");
const windowsHelperDestPath = process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH || path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "windows-bridge.exe");
const linuxCrateDir = path.join(rootDir, "native", "linux", "bridge-rs");
const linuxHelperDestPath = process.env.PI_COMPUTER_USE_LINUX_HELPER_PATH || path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "linux-bridge");
export const helperSourceRelativePaths = ["agent_cursor.swift", "agent_cursor_motion.swift", "foreground_gate.swift", "bridge.swift"]
	.map((file) => path.posix.join("native", "macos", file));
export function resolveHelperSourcePaths(repositoryRoot = rootDir) {
	return helperSourceRelativePaths.map((file) => path.join(repositoryRoot, ...file.split("/")));
}
const helperSourcePaths = resolveHelperSourcePaths();
const packageJsonPath = path.join(rootDir, "package.json");
const releaseRepo = "injaneity/pi-computer-use";
const localCodeSignCommonName = "pi-computer-use Local Signing (com.injaneity.pi-computer-use)";
const workbenchCodeSignCommonName = "Workbench Local Development";
const unsignedDevelopmentRequirement = "explicit-unsigned-development";
const signingIdentityStatePath = path.join(
	process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
	"pi-computer-use",
	"macos-code-signing-identity",
);
const localSigningLockPath = path.join(os.tmpdir(), `pi-computer-use-local-signing-${typeof process.getuid === "function" ? process.getuid() : "user"}.lock`);

const args = new Set(process.argv.slice(2));
const isPostinstall = args.has("--postinstall");
const allowBuildFallback = args.has("--allow-build") || args.has("--runtime") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
const allowLinuxBuildFallback = args.has("--allow-build") || process.env.PI_COMPUTER_USE_ALLOW_BUILD === "1";
const allowAdhocUpdate = args.has("--allow-adhoc-update") || process.env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE === "1";
export function shouldUseLocalMacBuild(argv = process.argv, environment = process.env) {
	return argv.includes("--local-build") || environment.PI_COMPUTER_USE_LOCAL_BUILD === "1";
}
const forceLocalMacBuild = shouldUseLocalMacBuild(process.argv, process.env);

function getArg(name) {
	const index = process.argv.indexOf(name);
	if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
	return undefined;
}
const archTriples = {
	arm64: "arm64-apple-macosx",
	x64: "x86_64-apple-macosx",
};
const deploymentTarget = "14.0";
const frameworks = ["ApplicationServices", "AppKit", "ScreenCaptureKit", "Foundation", "SwiftUI"];
const defaultCodeSignIdentifier = "com.injaneity.pi-computer-use";

function normalizeArch(arch) {
	if (arch === "arm64" || arch === "x64") return arch;
	throw new Error(`Unsupported architecture '${arch}'. Supported: arm64, x64.`);
}

function prebuiltPathForArch(arch) {
	return path.join(rootDir, "prebuilt", "macos", arch, "bridge");
}

function prebuiltAppPathForArch(arch) {
	return path.join(rootDir, "prebuilt", "macos", arch, "pi-computer-use.app");
}

const releaseAssetName = "pi-computer-use.app.zip";

async function packageVersion() {
	const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
	if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
		throw new Error(`Could not read package version from ${packageJsonPath}.`);
	}
	return packageJson.version;
}

function githubReleaseUrl(tag, assetName) {
	return `https://github.com/${releaseRepo}/releases/download/${tag}/${assetName}`;
}

async function exists(filePath) {
	try {
		await fs.access(filePath, fsConstants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function hashFile(filePath) {
	const data = await fs.readFile(filePath);
	return createHash("sha256").update(data).digest("hex");
}

async function copyIfChanged(sourcePath, destinationPath) {
	const destinationExists = await exists(destinationPath);
	if (destinationExists) {
		const [sourceHash, destinationHash] = await Promise.all([hashFile(sourcePath), hashFile(destinationPath)]);
		if (sourceHash === destinationHash) {
			await fs.chmod(destinationPath, 0o755);
			return { changed: false };
		}
	}

	await fs.mkdir(path.dirname(destinationPath), { recursive: true });
	const tempPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
	await fs.copyFile(sourcePath, tempPath);
	await fs.chmod(tempPath, 0o755);
	try {
		await fs.rename(tempPath, destinationPath);
	} catch (err) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		if (err.code === "EPERM") {
			throw new Error(`Cannot update helper at ${destinationPath} — the existing helper process is still running. Close the helper process and re-run this script.`);
		}
		throw err;
	}
	return { changed: true };
}

async function run(command, commandArgs) {
	await new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(`Command failed (${code}): ${command} ${commandArgs.join(" ")}`));
		});
	});
}

function moduleCachePath(arch) {
	return path.join(os.tmpdir(), `pi-computer-use-swift-module-cache-${arch}`);
}

async function commandOutput(command, commandArgs) {
	const { stdout } = await execFile(command, commandArgs, { encoding: "utf8" });
	return stdout;
}

export function parseDesignatedRequirement(output) {
	const match = String(output).match(/designated\s*=>\s*(.+)/i);
	if (!match) throw new Error("codesign did not report a designated requirement for the helper app.");
	return match[1].trim().replace(/\s+/g, " ");
}

async function readDesignatedRequirement(appPath) {
	const result = await execFile("codesign", ["-d", "-r", "-", appPath], { encoding: "utf8" }).catch((error) => {
		const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
		if (/code object is not signed at all/i.test(output)) return { stdout: output, stderr: "" };
		throw error;
	});
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	try {
		return parseDesignatedRequirement(output);
	} catch (error) {
		if (/code object is not signed at all/i.test(output)) return unsignedDevelopmentRequirement;
		throw error;
	}
}

async function readInstalledSigningIdentity(appPath) {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-signing-identity-"));
	try {
		await execFile("codesign", ["-d", "--extract-certificates", appPath], { cwd: tempDir, encoding: "utf8" });
		const leafCertificate = await fs.readFile(path.join(tempDir, "codesign0"));
		return createHash("sha1").update(leafCertificate).digest("hex").toUpperCase();
	} catch {
		const output = await execFile("codesign", ["-dv", "--verbose=4", appPath], { encoding: "utf8" }).then(
			(result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
			(error) => `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`,
		);
		return /Signature=adhoc/i.test(output) ? "-" : undefined;
	} finally {
		await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
	}
}

function helperIdentityError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function updateTransactionPaths(installPath, transactionId) {
	return {
		manifestPath: `${installPath}.update-transaction.json`,
		stagingPath: `${installPath}.staging-${transactionId}`,
		backupPath: `${installPath}.backup-${transactionId}`,
	};
}

async function pathExists(fileSystem, filePath) {
	return await fileSystem.access(filePath).then(() => true, () => false);
}

async function hashBundle(bundlePath, fileSystem = fs) {
	const hash = createHash("sha256");
	async function visit(currentPath, relativePath) {
		const entries = await fileSystem.readdir(currentPath, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			const childPath = path.join(currentPath, entry.name);
			const childRelative = path.posix.join(relativePath, entry.name);
			if (entry.isSymbolicLink()) {
				hash.update(`link\0${childRelative}\0${await fileSystem.readlink(childPath)}\0`);
			} else if (entry.isDirectory()) {
				hash.update(`directory\0${childRelative}\0`);
				await visit(childPath, childRelative);
			} else if (entry.isFile()) {
				const contents = await fileSystem.readFile(childPath);
				hash.update(`file\0${childRelative}\0${contents.length}\0`);
				hash.update(contents);
			}
		}
	}
	await visit(bundlePath, "");
	return hash.digest("hex");
}

function validateUpdateManifest(manifest, installPath) {
	const transactionId = manifest?.transactionId;
	const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	const validRecord = (record) => record === null || (
		record &&
		typeof record.designatedRequirement === "string" && record.designatedRequirement.length > 0 &&
		/^[0-9a-f]{64}$/i.test(record.bundleSha256)
	);
	if (
		manifest?.format !== "pi-computer-use-helper-update-v1" ||
		!uuidPattern.test(transactionId ?? "") ||
		manifest.installPath !== path.resolve(installPath) ||
		!validRecord(manifest.previous) || !validRecord(manifest.candidate) || manifest.candidate === null ||
	(manifest.identityMigration !== undefined && manifest.identityMigration !== "explicit-ad-hoc") ||
	(manifest.previous !== null && manifest.candidate.designatedRequirement !== manifest.previous.designatedRequirement && manifest.identityMigration !== "explicit-ad-hoc")
	) {
		throw helperIdentityError("ERR_HELPER_UPDATE_RECOVERY_INVALID", "The pending helper update record is invalid or refers to a different signing identity. No bundle was moved or deleted.");
	}
	const expectedPaths = updateTransactionPaths(installPath, transactionId);
	if (manifest.stagingPath !== expectedPaths.stagingPath || manifest.backupPath !== expectedPaths.backupPath) {
		throw helperIdentityError("ERR_HELPER_UPDATE_RECOVERY_INVALID", "The pending helper update record contains unexpected recovery paths. No bundle was moved or deleted.");
	}
	return { ...manifest, ...expectedPaths };
}

async function verifyRecoveryBundle(bundlePath, record, { fileSystem = fs, verifySignature, readRequirement }) {
	if (!(await pathExists(fileSystem, bundlePath))) return false;
	if (record.designatedRequirement !== "explicit-unsigned-development") await verifySignature(bundlePath);
	const [designatedRequirement, bundleSha256] = await Promise.all([
		readRequirement(bundlePath),
		hashBundle(bundlePath, fileSystem),
	]);
	if (designatedRequirement !== record.designatedRequirement || bundleSha256 !== record.bundleSha256) {
		throw helperIdentityError("ERR_HELPER_UPDATE_RECOVERY_MISMATCH", `The bundle at ${bundlePath} does not match the signed recovery record. No bundle was moved or deleted.`);
	}
	return true;
}

async function recoverPendingHelperUpdate(installPath, {
	fileSystem = fs,
	verifySignature = (appPath) => run("codesign", ["--verify", "--strict", appPath]),
	readRequirement = readDesignatedRequirement,
} = {}) {
	const manifestPath = `${installPath}.update-transaction.json`;
	const contents = await fileSystem.readFile(manifestPath, "utf8").catch((error) => {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	});
	if (contents === undefined) return false;
	let manifest;
	try {
		manifest = validateUpdateManifest(JSON.parse(contents), installPath);
	} catch (error) {
		if (error?.code === "ERR_HELPER_UPDATE_RECOVERY_INVALID") throw error;
		throw helperIdentityError("ERR_HELPER_UPDATE_RECOVERY_INVALID", `Could not validate the pending helper update record. No bundle was moved or deleted: ${error instanceof Error ? error.message : String(error)}`);
	}

	const installedExists = await pathExists(fileSystem, installPath);
	const backupExists = await pathExists(fileSystem, manifest.backupPath);
	const stagingExists = await pathExists(fileSystem, manifest.stagingPath);
	let installedRole;
	if (installedExists) {
		const installedRequirement = await readRequirement(installPath);
		if (installedRequirement !== unsignedDevelopmentRequirement) await verifySignature(installPath);
		const installedHash = await hashBundle(installPath, fileSystem);
		const installedCandidate = installedRequirement === manifest.candidate.designatedRequirement && installedHash === manifest.candidate.bundleSha256;
		const installedPrevious = manifest.previous &&
			installedRequirement === manifest.previous.designatedRequirement && installedHash === manifest.previous.bundleSha256;
		if (!installedCandidate && !installedPrevious) {
			throw helperIdentityError("ERR_HELPER_UPDATE_RECOVERY_MISMATCH", "The installed helper does not match either bundle recorded by the pending update. No bundle was moved or deleted.");
		}
		installedRole = installedCandidate ? "candidate" : "previous";
	}
	if (stagingExists && (backupExists || !installedExists)) {
		// Once the old bundle has moved, the staged candidate must match the
		// recorded signature and digest before recovery changes either path.
		await verifyRecoveryBundle(manifest.stagingPath, manifest.candidate, { fileSystem, verifySignature, readRequirement });
	}

	if (backupExists) {
		if (!manifest.previous) {
			throw helperIdentityError("ERR_HELPER_UPDATE_RECOVERY_MISMATCH", "A first-install transaction unexpectedly has a backup bundle. No bundle was moved or deleted.");
		}
		await verifyRecoveryBundle(manifest.backupPath, manifest.previous, { fileSystem, verifySignature, readRequirement });
	}

	if (!installedExists) {
		if (backupExists) {
			// The previous bundle is the only validated app. Restore it before
			// looking at the current pin or starting another update.
			await fileSystem.rename(manifest.backupPath, installPath);
			await verifyRecoveryBundle(installPath, manifest.previous, { fileSystem, verifySignature, readRequirement });
		} else if (!manifest.previous && stagingExists) {
			await verifyRecoveryBundle(manifest.stagingPath, manifest.candidate, { fileSystem, verifySignature, readRequirement });
			await fileSystem.rename(manifest.stagingPath, installPath);
			await verifyRecoveryBundle(installPath, manifest.candidate, { fileSystem, verifySignature, readRequirement });
		} else if (!manifest.previous && !stagingExists) {
			// A first install may stop before copying anything. There is no prior
			// app to restore, and clearing this exact empty transaction lets setup
			// retry without guessing at unrelated paths.
			await fileSystem.rm(manifestPath, { force: true });
			return true;
		} else {
			throw helperIdentityError("ERR_HELPER_UPDATE_RECOVERY_MISMATCH", "The pending helper update has no validated bundle to restore. No bundle was moved or deleted.");
		}
	} else if (backupExists) {
		// Keep the backup until the installed candidate or previous bundle has
		// been verified above; only then is it safe to remove the duplicate.
		if (installedRole !== "candidate" && installedRole !== "previous") {
			throw helperIdentityError("ERR_HELPER_UPDATE_RECOVERY_MISMATCH", "The installed bundle state is ambiguous. No bundle was moved or deleted.");
		}
		await fileSystem.rm(manifest.backupPath, { force: true, recursive: true });
	}

	if (stagingExists) await fileSystem.rm(manifest.stagingPath, { force: true, recursive: true });
	await fileSystem.rm(manifestPath, { force: true });
	return true;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

async function downloadFile(url, outputPath) {
	const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	if (!response.body) {
		throw new Error("empty response body");
	}
	await pipeline(response.body, createWriteStream(outputPath));
}

async function releaseChecksums(tag) {
	const response = await fetch(githubReleaseUrl(tag, "SHA256SUMS"), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) return new Map();
	const text = await response.text();
	const checksums = new Map();
	for (const line of text.split("\n")) {
		const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
		if (match) checksums.set(path.basename(match[2]), match[1].toLowerCase());
	}
	return checksums;
}

async function verifySha256(filePath, expected) {
	const file = await fs.readFile(filePath);
	const actual = createHash("sha256").update(file).digest("hex");
	if (actual !== expected.toLowerCase()) {
		throw new Error(`SHA256 mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`);
	}
}

async function findExtractedHelperApp(extractDir) {
	const direct = path.join(extractDir, "pi-computer-use.app");
	if (await exists(direct)) return direct;
	const entries = await fs.readdir(extractDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const entryPath = path.join(extractDir, entry.name);
		if (entry.name === "pi-computer-use.app") return entryPath;
		const nested = await findExtractedHelperApp(entryPath);
		if (nested) return nested;
	}
	return undefined;
}

async function downloadReleaseHelperApp() {
	const version = await packageVersion();
	const tag = `v${version}`;
	const checksums = await releaseChecksums(tag).catch(() => new Map());
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-release-helper-"));
	try {
		const zipPath = path.join(tempDir, releaseAssetName);
		await downloadFile(githubReleaseUrl(tag, releaseAssetName), zipPath);
		const expectedSha = checksums.get(releaseAssetName);
		if (expectedSha) await verifySha256(zipPath, expectedSha);
		const extractDir = path.join(tempDir, "extract");
		await fs.mkdir(extractDir, { recursive: true });
		await run("/usr/bin/ditto", ["-x", "-k", zipPath, extractDir]);
		const appPath = await findExtractedHelperApp(extractDir);
		if (!appPath) throw new Error(`missing pi-computer-use.app in ${releaseAssetName}`);
		return { appPath, tempDir, assetName: releaseAssetName, tag };
	} catch (error) {
		await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
		throw new Error(`No signed helper release asset found for ${tag}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function findDeveloperIdIdentity() {
	const output = await commandOutput("security", ["find-identity", "-p", "codesigning", "-v"]).catch(() => "");
	return parseCodeSigningIdentityEntries(output)
		.filter((identity) => identity.commonName.includes("Developer ID Application"))
		.map((identity) => identity.fingerprint)
	.sort((left, right) => left.localeCompare(right))[0];
}

export function parseCodeSigningIdentities(output, commonName = localCodeSignCommonName) {
	return parseCodeSigningIdentityEntries(output)
		.filter((identity) => identity.commonName === commonName)
		.map((identity) => identity.fingerprint);
}

export function parseCodeSigningIdentityEntries(output) {
	return output.split("\n")
		.map((line) => line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/i))
		.filter(Boolean)
		.map((match) => ({ fingerprint: match[1].toUpperCase(), commonName: match[2] }));
}

export function selectLocalCodeSigningIdentity(validOutput, matchingOutput, {
	appIdentityName = localCodeSignCommonName,
	workbenchIdentityName = workbenchCodeSignCommonName,
} = {}) {
	const valid = parseCodeSigningIdentityEntries(validOutput);
	for (const commonName of [appIdentityName, workbenchIdentityName]) {
		const identity = valid
			.filter((entry) => entry.commonName === commonName)
			.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint))[0];
		if (identity) return identity.fingerprint;
	}
	return parseCodeSigningIdentities(matchingOutput, appIdentityName)
		.sort((left, right) => left.localeCompare(right))[0];
}

async function findLocalSigningIdentity() {
	const [validOutput, matchingOutput] = await Promise.all([
		commandOutput("security", ["find-identity", "-v", "-p", "codesigning"]).catch(() => ""),
		commandOutput("security", ["find-identity", "-p", "codesigning"]).catch(() => ""),
	]);
	return selectLocalCodeSigningIdentity(validOutput, matchingOutput);
}

async function identityIsAvailable(fingerprint, { validOnly = false } = {}) {
	const args = ["find-identity", ...(validOnly ? ["-v"] : []), "-p", "codesigning"];
	const output = await commandOutput("security", args).catch(() => "");
	return parseCodeSigningIdentityEntries(output).some((identity) => identity.fingerprint === fingerprint);
}

async function readPinnedSigningIdentity() {
	const value = await fs.readFile(signingIdentityStatePath, "utf8").catch((error) => {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	});
	if (value === undefined) return undefined;
	const fingerprint = value.trim().toUpperCase();
	if (!/^[0-9A-F]{40}$/.test(fingerprint)) {
		throw new Error(`Stored macOS signing identity is malformed at ${signingIdentityStatePath}. Set PI_COMPUTER_USE_CODESIGN_IDENTITY to an available SHA-1 fingerprint to replace it deliberately.`);
	}
	return fingerprint;
}

async function persistPinnedSigningIdentity(fingerprint) {
	const parent = path.dirname(signingIdentityStatePath);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const tempPath = `${signingIdentityStatePath}.tmp-${process.pid}-${Date.now()}`;
	try {
		await fs.writeFile(tempPath, `${fingerprint}\n`, { mode: 0o600 });
		await fs.chmod(tempPath, 0o600);
		await fs.rename(tempPath, signingIdentityStatePath);
		await fs.chmod(signingIdentityStatePath, 0o600);
	} finally {
		await fs.rm(tempPath, { force: true }).catch(() => {});
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const directoryLockHost = os.hostname();

function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid < 1) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		if (error?.code === "EPERM") return true;
		return undefined;
	}
}

async function readDirectoryLockOwner(lockPath) {
	return await fs.readFile(path.join(lockPath, "owner.json"), "utf8").then((contents) => {
		const owner = JSON.parse(contents);
		if (
			typeof owner?.token !== "string" || owner.token.length === 0 ||
			!Number.isInteger(owner.pid) || typeof owner.host !== "string"
		) return undefined;
		return owner;
	}).catch(() => undefined);
}

async function writeDirectoryLockOwner(lockPath, owner) {
	await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
}

async function directoryLockOwnerMatches(lockPath, owner) {
	const current = await readDirectoryLockOwner(lockPath);
	return current?.token === owner.token && current.pid === owner.pid && current.host === owner.host;
}

async function reclaimDeadDirectoryLock(lockPath, newOwner, staleMs) {
	const reaperPath = `${lockPath}.reaper`;
	try {
		await fs.mkdir(reaperPath);
	} catch (error) {
		if (error?.code === "EEXIST") return false;
		throw error;
	}
	const reaperOwner = { token: randomUUID(), pid: process.pid, host: directoryLockHost };
	let reaperOwnerWritten = false;
	try {
		await writeDirectoryLockOwner(reaperPath, reaperOwner);
		reaperOwnerWritten = true;
		const previousOwner = await readDirectoryLockOwner(lockPath);
		const lockStat = await fs.stat(lockPath).catch(() => undefined);
		const deadOwner = previousOwner?.host === directoryLockHost && processIsAlive(previousOwner.pid) === false;
		const abandonedInitialization = !previousOwner && lockStat && Date.now() - lockStat.mtimeMs > staleMs;
		if (!deadOwner && !abandonedInitialization) return false;

		// Only one contender can hold the reaper directory while it moves the
		// dead owner aside and creates the replacement. Other contenders wait;
		// they cannot mistake the new owner's lock for the old one.
		const tombstonePath = `${lockPath}.stale-${previousOwner?.token ?? randomUUID()}`;
		await fs.rename(lockPath, tombstonePath);
		try {
			await fs.mkdir(lockPath);
			await writeDirectoryLockOwner(lockPath, newOwner);
		} catch (error) {
			if (error?.code !== "EEXIST") {
				const current = await readDirectoryLockOwner(lockPath);
				if (current?.token === newOwner.token) await fs.rm(lockPath, { force: true, recursive: true }).catch(() => {});
			}
			await fs.rm(tombstonePath, { force: true, recursive: true }).catch(() => {});
			if (error?.code === "EEXIST") return false;
			throw error;
		}
		await fs.rm(tombstonePath, { force: true, recursive: true }).catch(() => {});
		return true;
	} finally {
		if (!reaperOwnerWritten || await directoryLockOwnerMatches(reaperPath, reaperOwner)) {
			await fs.rm(reaperPath, { force: true, recursive: true }).catch(() => {});
		}
	}
}

function lockBusyError(lockPath, reason) {
	const error = new Error(`Directory lock is busy at ${lockPath}${reason ? `: ${reason}` : "."}`);
	error.code = "ERR_DIRECTORY_LOCK_BUSY";
	return error;
}

export async function withDirectoryLock(lockPath, callback, { waitMs = 15_000, staleMs = 300_000, retryMs = 50, heartbeatMs = 5_000 } = {}) {
	const deadline = Date.now() + waitMs;
	const owner = { token: randomUUID(), pid: process.pid, host: directoryLockHost, createdAt: new Date().toISOString() };
	let acquired = false;
	let activeOwnerObserved = false;
	while (true) {
		if (await fs.access(`${lockPath}.reaper`).then(() => true, () => false)) {
			if (Date.now() >= deadline) throw lockBusyError(lockPath, "another process is recovering a dead owner");
			await delay(retryMs);
			continue;
		}
		try {
			mkdirSync(lockPath);
			writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
			acquired = true;
			break;
		} catch (error) {
			if (error?.code === "EEXIST") {
				const currentOwner = await readDirectoryLockOwner(lockPath);
				if (currentOwner?.host === directoryLockHost && processIsAlive(currentOwner.pid) === true) {
					activeOwnerObserved = true;
				} else if (currentOwner?.host === directoryLockHost && processIsAlive(currentOwner.pid) === false) {
					await reclaimDeadDirectoryLock(lockPath, owner, staleMs);
					acquired = await directoryLockOwnerMatches(lockPath, owner);
					if (acquired) break;
				} else {
					const stat = await fs.stat(lockPath).catch(() => undefined);
					if (!currentOwner && stat && Date.now() - stat.mtimeMs > staleMs) {
						await reclaimDeadDirectoryLock(lockPath, owner, staleMs);
						acquired = await directoryLockOwnerMatches(lockPath, owner);
						if (acquired) break;
					}
				}
			} else {
				throw error;
			}
			if (Date.now() >= deadline) {
				throw lockBusyError(lockPath, activeOwnerObserved
					? "owner process is still alive; an expired heartbeat does not authorize lock takeover"
					: "owner is unknown or another process is reclaiming it");
			}
			await delay(retryMs);
		}
	}
	const heartbeat = heartbeatMs > 0 ? setInterval(async () => {
		if (!(await directoryLockOwnerMatches(lockPath, owner))) return;
		const now = new Date();
		await Promise.all([
			fs.utimes(lockPath, now, now),
			fs.utimes(path.join(lockPath, "owner.json"), now, now),
		]).catch(() => {});
	}, heartbeatMs) : undefined;
	heartbeat?.unref?.();
	try {
		return await callback();
	} finally {
		if (heartbeat) clearInterval(heartbeat);
		if (acquired && await directoryLockOwnerMatches(lockPath, owner)) {
			await fs.rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
		}
	}
}

export async function ensureIdentityOnce(findIdentity, createIdentity, withLock) {
	return (await findIdentity()) ?? await withLock(async () => (await findIdentity()) ?? await createIdentity());
}

async function loginKeychainPath() {
	for (const candidate of [
		path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
		path.join(os.homedir(), "Library", "Keychains", "login.keychain"),
	]) {
		if (await exists(candidate)) return candidate;
	}
	return undefined;
}

async function ensureLocalSigningIdentity() {
	if (process.platform !== "darwin") return undefined;
	if (!(await commandOutput("which", ["codesign"]).catch(() => ""))) return undefined;
	const existingIdentity = await findLocalSigningIdentity();
	if (existingIdentity) return existingIdentity;
	if (!(await commandOutput("which", ["openssl"]).catch(() => ""))) return undefined;
	const keychain = await loginKeychainPath();
	if (!keychain) return undefined;

	return await ensureIdentityOnce(findLocalSigningIdentity, createLocalSigningIdentity, (callback) => withDirectoryLock(localSigningLockPath, callback));
}

async function createLocalSigningIdentity() {
	const keychain = await loginKeychainPath();
	if (!keychain) return undefined;
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-signing-"));
	const password = `pi-computer-use-local-${process.pid}-${Date.now()}`;
	try {
		const configPath = path.join(tempDir, "req.cnf");
		await fs.writeFile(configPath, [
			"[req]",
			"distinguished_name=dn",
			"x509_extensions=ext",
			"prompt=no",
			"[dn]",
			`CN=${localCodeSignCommonName}`,
			"[ext]",
			"basicConstraints=critical,CA:FALSE",
			"keyUsage=critical,digitalSignature",
			"extendedKeyUsage=critical,codeSigning",
			"",
		].join("\n"));
		const keyPath = path.join(tempDir, "key.pem");
		const certPath = path.join(tempDir, "cert.pem");
		const p12Path = path.join(tempDir, "id.p12");
		await execFile("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "3650", "-nodes", "-config", configPath]);
		await execFile("openssl", ["pkcs12", "-export", "-legacy", "-inkey", keyPath, "-in", certPath, "-out", p12Path, "-passout", `pass:${password}`, "-name", localCodeSignCommonName])
			.catch(async () => {
				await execFile("openssl", ["pkcs12", "-export", "-inkey", keyPath, "-in", certPath, "-out", p12Path, "-passout", `pass:${password}`, "-name", localCodeSignCommonName]);
			});
		await execFile("security", ["import", p12Path, "-k", keychain, "-P", password, "-A", "-T", "/usr/bin/codesign"]);
		const identity = await findLocalSigningIdentity();
		if (!identity) throw new Error("Imported local signing certificate is not a valid code-signing identity.");
		return identity;
	} catch (error) {
		console.warn(`[pi-computer-use] could not create a valid local signing identity: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	} finally {
		await fs.rm(tempDir, { force: true, recursive: true }).catch(() => {});
	}
}

async function resolveCodeSignIdentity() {
	const explicit = process.env.PI_COMPUTER_USE_CODESIGN_IDENTITY?.trim().toUpperCase();
	if (explicit) {
		if (!/^[0-9A-F]{40}$/.test(explicit)) {
			throw new Error("PI_COMPUTER_USE_CODESIGN_IDENTITY must be an exact 40-character certificate SHA-1 fingerprint.");
		}
		if (!(await identityIsAvailable(explicit, { validOnly: true }))) {
			throw new Error(`PI_COMPUTER_USE_CODESIGN_IDENTITY ${explicit} is not an effective identity in the current code-signing keychain search list.`);
		}
		await persistPinnedSigningIdentity(explicit);
		return explicit;
	}

	const pinned = await readPinnedSigningIdentity();
	if (pinned) {
		if (!(await identityIsAvailable(pinned))) {
			throw new Error(`The pinned macOS signing identity ${pinned} is no longer available. Restore that certificate and private key, or deliberately select a replacement with PI_COMPUTER_USE_CODESIGN_IDENTITY.`);
		}
		return pinned;
	}

	const identity = (await findDeveloperIdIdentity()) ?? (await findLocalSigningIdentity()) ?? (await ensureLocalSigningIdentity()) ?? "-";
	if (identity !== "-") await persistPinnedSigningIdentity(identity);
	return identity;
}

async function signHelperWithIdentity(outputPath, identifier, identity) {
	if (identity === "unsigned") return identity;
	const commandArgs = ["--force", "--deep", "-i", identifier, "--timestamp=none", "--sign", identity, outputPath];
	await run("codesign", commandArgs);
	if (identity === "-") {
		console.warn("[pi-computer-use] warning: signed helper ad-hoc; macOS may require permission review after native helper changes. Release installs should use a Developer ID-signed helper app.");
	} else {
		console.log(`[pi-computer-use] signed ${outputPath} with pinned code-signing identity ${identity}. macOS may require permission review when the designated requirement changes.`);
	}
	return identity;
}

async function registerHelperApp(appPath = helperAppPath) {
	const lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
	if (!(await exists(lsregister))) return;
	await run(lsregister, ["-f", appPath]).catch(() => {});
}

async function installPrebuiltHelperAppLocked(sourceAppPath, {
	installPath,
	fileSystem,
	verifySignature,
	readRequirement,
	readPinnedIdentity,
	checkIdentityAvailable,
	copyBundle,
	register,
	identityMigration,
	afterOldBundleMoved,
	afterNewBundleInstalled,
}) {
	const sourceExecutablePath = path.join(sourceAppPath, "Contents", "MacOS", "bridge");
	const sourceInfoPath = path.join(sourceAppPath, "Contents", "Info.plist");
	const installExecutablePath = path.join(installPath, "Contents", "MacOS", "bridge");
	const installInfoPath = path.join(installPath, "Contents", "Info.plist");
	await verifySignature(sourceAppPath);
	const candidateRequirement = await readRequirement(sourceAppPath);
	const existingExecutable = await fileSystem.readFile(installExecutablePath).catch(() => undefined);
	const sourceExecutable = await fileSystem.readFile(sourceExecutablePath);
	const existingInfo = await fileSystem.readFile(installInfoPath, "utf8").catch(() => undefined);
	const sourceInfo = await fileSystem.readFile(sourceInfoPath, "utf8");
	const candidateHash = await hashBundle(sourceAppPath, fileSystem);
	const installedAppExists = await pathExists(fileSystem, installPath);
	const installedHash = installedAppExists ? await hashBundle(installPath, fileSystem) : undefined;
	if (existingExecutable?.equals(sourceExecutable) && existingInfo === sourceInfo && installedHash === candidateHash) {
		await verifySignature(installPath);
		if (await readRequirement(installPath) !== candidateRequirement) {
			throw helperIdentityError(
				"ERR_HELPER_IDENTITY_MISMATCH",
				"The installed helper has a different designated requirement from the pre-signed package. The installed app was preserved.",
			);
		}
		await register(installPath);
		return false;
	}
	// The sealed bundle must arrive intact — a broken signature would burn
	// the user's TCC grants on an identity that can never validate.
	const pinnedIdentity = await readPinnedIdentity();
	if (pinnedIdentity && !(await checkIdentityAvailable(pinnedIdentity))) {
		throw helperIdentityError(
			"ERR_PINNED_HELPER_IDENTITY_UNAVAILABLE",
			"The pinned macOS signing identity certificate is unavailable. Restore that certificate before updating the pre-signed helper; the installed app was preserved.",
		);
	}
	if (pinnedIdentity && !installedAppExists) {
		throw helperIdentityError(
			"ERR_PINNED_HELPER_IDENTITY_UNVERIFIABLE",
			"A pinned macOS signing identity exists but the installed helper is missing, so its designated requirement cannot be checked. Restore the helper or perform a deliberate identity migration; no pre-signed app was installed.",
		);
	}
	if (installedAppExists) {
		await verifySignature(installPath);
		const installedRequirement = await readRequirement(installPath);
		if (installedRequirement !== candidateRequirement && identityMigration !== "explicit-ad-hoc") {
			throw helperIdentityError(
				"ERR_HELPER_IDENTITY_MISMATCH",
				"The pre-signed helper has a different designated requirement from the installed helper. The installed app was preserved; change signing identity only through a deliberate migration.",
			);
		}
	}

	const candidateRecord = {
		designatedRequirement: candidateRequirement,
		bundleSha256: candidateHash,
	};
	const previousRecord = installedAppExists
		? { designatedRequirement: await readRequirement(installPath), bundleSha256: await hashBundle(installPath, fileSystem) }
		: null;
	const transactionId = randomUUID();
	const paths = updateTransactionPaths(installPath, transactionId);
	const manifest = {
		format: "pi-computer-use-helper-update-v1",
		transactionId,
		installPath: path.resolve(installPath),
		stagingPath: paths.stagingPath,
		backupPath: paths.backupPath,
		previous: previousRecord,
		candidate: candidateRecord,
		...(identityMigration ? { identityMigration } : {}),
		createdAt: new Date().toISOString(),
	};
	const tempManifestPath = `${paths.manifestPath}.tmp-${transactionId}`;
	await fileSystem.writeFile(tempManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
	try {
		await fileSystem.rename(tempManifestPath, paths.manifestPath);
	} catch (error) {
		await fileSystem.rm(tempManifestPath, { force: true }).catch(() => {});
		throw error;
	}

	try {
		await copyBundle(sourceAppPath, paths.stagingPath);
		await verifyRecoveryBundle(paths.stagingPath, candidateRecord, { fileSystem, verifySignature, readRequirement });
		if (installedAppExists) {
			await fileSystem.rename(installPath, paths.backupPath);
			await afterOldBundleMoved?.();
		}
		await fileSystem.rename(paths.stagingPath, installPath);
	} catch (error) {
		await recoverPendingHelperUpdate(installPath, { fileSystem, verifySignature, readRequirement }).catch((recoveryError) => {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message}; helper update recovery remains pending: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
		});
		throw error;
	}

	await afterNewBundleInstalled?.();
	await verifyRecoveryBundle(installPath, candidateRecord, { fileSystem, verifySignature, readRequirement });
	await register(installPath);
	if (previousRecord) {
		await verifyRecoveryBundle(paths.backupPath, previousRecord, { fileSystem, verifySignature, readRequirement });
		await fileSystem.rm(paths.backupPath, { force: true, recursive: true });
	}
	await fileSystem.rm(paths.manifestPath, { force: true });
	return true;
}

async function withHelperUpdateLock(installPath, callback, lockOptions) {
	installPath = path.resolve(installPath);
	await fs.mkdir(path.dirname(installPath), { recursive: true });
	await fs.access(path.dirname(installPath), fsConstants.W_OK);
	return withDirectoryLock(`${installPath}.update-lock`, callback, lockOptions);
}

export async function installPrebuiltHelperApp(sourceAppPath, {
	installPath = helperAppPath,
	fileSystem = fs,
	verifySignature = (appPath) => run("codesign", ["--verify", "--strict", appPath]),
	readRequirement = readDesignatedRequirement,
	readPinnedIdentity = readPinnedSigningIdentity,
	checkIdentityAvailable = identityIsAvailable,
	copyBundle = (source, destination) => run("/usr/bin/ditto", [source, destination]),
	register = (appPath) => registerHelperApp(appPath),
	lockOptions = { waitMs: 60_000, staleMs: 30_000, retryMs: 100 },
	afterOldBundleMoved,
	afterNewBundleInstalled,
} = {}) {
	installPath = path.resolve(installPath);
	return await withHelperUpdateLock(installPath, async () => {
		await recoverPendingHelperUpdate(installPath, { fileSystem, verifySignature, readRequirement });
		return await installPrebuiltHelperAppLocked(sourceAppPath, {
			installPath,
			fileSystem,
			verifySignature,
			readRequirement,
			readPinnedIdentity,
			checkIdentityAvailable,
			copyBundle,
			register,
			afterOldBundleMoved,
			afterNewBundleInstalled,
		});
	}, lockOptions);
}

function helperInfoPlist(version) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${helperBundleId}</string>
<key>CFBundleName</key><string>pi-computer-use</string>
<key>CFBundleDisplayName</key><string>pi-computer-use</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`;
}

function helperCompilerArgs(arch, { outputPath = "<OUTPUT>", moduleCache = "<MODULE_CACHE>" } = {}) {
	const swiftArgs = [
		"swiftc",
		"-target",
		`${archTriples[arch]}${deploymentTarget}`,
		"-module-cache-path",
		moduleCache,
		"-O",
	];
	for (const framework of frameworks) swiftArgs.push("-framework", framework);
	swiftArgs.push(...helperSourcePaths, "-o", outputPath);
	return swiftArgs;
}

function normalizedHelperCompilerArgs(arch) {
	return helperCompilerArgs(arch).map((arg) => {
		if (path.isAbsolute(arg) && arg.startsWith(`${rootDir}${path.sep}`)) return path.relative(rootDir, arg).split(path.sep).join("/");
		return arg;
	});
}

async function readSwiftToolchainIdentity() {
	const [swiftcPath, swiftcVersion, developerDirectory, sdkPath, sdkVersion, sdkBuildVersion] = await Promise.all([
		commandOutput("xcrun", ["--find", "swiftc"]),
		commandOutput("xcrun", ["swiftc", "--version"]),
		commandOutput("xcode-select", ["-p"]),
		commandOutput("xcrun", ["--sdk", "macosx", "--show-sdk-path"]),
		commandOutput("xcrun", ["--sdk", "macosx", "--show-sdk-version"]),
		commandOutput("xcrun", ["--sdk", "macosx", "--show-sdk-build-version"]),
	]);
	const resolvedSwiftcPath = swiftcPath.trim();
	return {
		swiftcPath: resolvedSwiftcPath,
		swiftcSha256: await hashFile(resolvedSwiftcPath),
		swiftcVersion: swiftcVersion.trim(),
		developerDirectory: developerDirectory.trim(),
		sdkPath: sdkPath.trim(),
		sdkVersion: sdkVersion.trim(),
		sdkBuildVersion: sdkBuildVersion.trim(),
	};
}

export async function createLocalMacBuildInput(arch, {
	sourcePaths = helperSourcePaths,
	repositoryRoot = rootDir,
	compilerArgs = normalizedHelperCompilerArgs(arch),
	getToolchainIdentity = readSwiftToolchainIdentity,
	toolchainIdentity,
	getVersion = packageVersion,
	installerRulesPath = fileURLToPath(import.meta.url),
	fileSystem = fs,
} = {}) {
	const version = await getVersion();
	const sources = await Promise.all(sourcePaths.map(async (sourcePath) => {
		const bytes = await fileSystem.readFile(sourcePath);
		return {
			path: path.relative(repositoryRoot, sourcePath).split(path.sep).join("/"),
			sha256: createHash("sha256").update(bytes).digest("hex"),
		};
	}));
	sources.sort((left, right) => left.path.localeCompare(right.path));
	const [resolvedToolchain, packageJson, installerRules] = await Promise.all([
		toolchainIdentity ?? getToolchainIdentity(),
		fileSystem.readFile(packageJsonPath, "utf8").then((contents) => JSON.parse(contents)),
		fileSystem.readFile(installerRulesPath),
	]);
	const input = {
		format: "pi-computer-use-local-helper-build-input-v1",
		arch,
		deploymentTarget,
		compiler: {
			command: "xcrun",
			arguments: compilerArgs,
		},
		toolchain: resolvedToolchain,
		sources,
		package: {
			name: packageJson.name,
			version,
			infoPlistSha256: createHash("sha256").update(helperInfoPlist(version)).digest("hex"),
		},
		installerRules: {
			path: "scripts/setup-helper.mjs",
			sha256: createHash("sha256").update(installerRules).digest("hex"),
		},
	};
	const canonical = JSON.stringify(input);
	return {
		format: "pi-computer-use-local-helper-build-seal-v1",
		fingerprint: createHash("sha256").update(canonical).digest("hex"),
		inputs: input,
	};
}

function serializeLocalBuildInput(buildInput) {
	return `${JSON.stringify(buildInput, null, 2)}\n`;
}

export async function installLocalHelperBinary(sourcePath, {
	installPath = helperAppPath,
	sourceHashPath = path.join(installPath, "Contents", "Resources", "source.sha256"),
	fileSystem = fs,
	getVersion = packageVersion,
	resolveSigningIdentity = () => process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "unsigned" : resolveCodeSignIdentity(),
	signBundle = (appPath, identity) => signHelperWithIdentity(appPath, helperBundleId, identity),
	verifySignature = (appPath) => run("codesign", ["--verify", "--strict", appPath]),
	readRequirement = readDesignatedRequirement,
	readInstalledIdentity = readInstalledSigningIdentity,
	readPinnedIdentity = readPinnedSigningIdentity,
	checkIdentityAvailable = identityIsAvailable,
	copyBundle = (source, destination) => run("/usr/bin/ditto", [source, destination]),
	register = (appPath) => registerHelperApp(appPath),
	lockOptions = { waitMs: 60_000, staleMs: 30_000, retryMs: 100 },
	allowAdhocIdentityUpdate = allowAdhocUpdate,
	buildInputMetadata,
	updateLockHeld = false,
} = {}) {
	installPath = path.resolve(installPath);
	sourceHashPath = path.resolve(sourceHashPath);
	const infoPlistPath = path.join(installPath, "Contents", "Info.plist");
	const executablePath = path.join(installPath, "Contents", "MacOS", "bridge");
	const identityMarkerPath = path.join(path.dirname(sourceHashPath), "signing-identity.sha1");
	const install = async () => {
		const localReadRequirement = async (appPath) => {
			try {
				return await readRequirement(appPath);
			} catch {
				return unsignedDevelopmentRequirement;
			}
		};
		const localVerifySignature = async (appPath) => {
			if (await localReadRequirement(appPath) !== unsignedDevelopmentRequirement) await verifySignature(appPath);
		};
		await recoverPendingHelperUpdate(installPath, {
			fileSystem,
			verifySignature: localVerifySignature,
			readRequirement: localReadRequirement,
		});

		const version = await getVersion();
		const infoPlist = helperInfoPlist(version);
		const sourceExecutable = await fileSystem.readFile(sourcePath);
		const sourceHash = createHash("sha256").update(sourceExecutable).digest("hex");
		const installedExists = await pathExists(fileSystem, installPath);
		const pinnedIdentity = await readPinnedIdentity();
		if (pinnedIdentity && !(await checkIdentityAvailable(pinnedIdentity))) {
			throw helperIdentityError(
				"ERR_PINNED_HELPER_IDENTITY_UNAVAILABLE",
				"The pinned macOS signing identity certificate is unavailable. Restore that certificate before building a replacement; the installed app was preserved.",
			);
		}
		if (pinnedIdentity && !installedExists) {
			throw helperIdentityError(
				"ERR_PINNED_HELPER_IDENTITY_UNVERIFIABLE",
				"A pinned macOS signing identity exists but the installed helper is missing, so its designated requirement cannot be checked. Restore the helper or perform a deliberate identity migration; no locally built app was installed.",
			);
		}
		const signingIdentity = await resolveSigningIdentity();
		const currentExecutable = await fileSystem.readFile(executablePath).catch(() => undefined);
		const currentInfo = await fileSystem.readFile(infoPlistPath, "utf8").catch(() => undefined);
		const currentSourceHash = await fileSystem.readFile(sourceHashPath, "utf8").catch(() => undefined);
		const currentIdentityMarker = await fileSystem.readFile(identityMarkerPath, "utf8").catch(() => undefined);
		if (!buildInputMetadata && installedExists && currentInfo === infoPlist && currentSourceHash?.trim() === sourceHash) {
			try {
				const installedRequirement = await readRequirement(installPath);
				if (installedRequirement === unsignedDevelopmentRequirement) {
					if (signingIdentity !== "unsigned" || currentIdentityMarker?.trim() !== "unsigned" || !currentExecutable?.equals(sourceExecutable)) {
						throw new Error("The unsigned helper does not match the trusted local source metadata.");
					}
				} else {
					await verifySignature(installPath);
					const installedIdentity = await readInstalledIdentity(installPath);
					if (!installedIdentity || currentIdentityMarker?.trim() !== installedIdentity || installedIdentity !== signingIdentity) {
						throw new Error("The installed helper signature identity does not match its sealed local metadata.");
					}
				}
				await register(installPath);
				return false;
			} catch {
				// Repair a damaged same-version bundle by building a verified staged app.
			}
		}
		if (signingIdentity === "unsigned" && installedExists && !allowAdhocIdentityUpdate) {
			throw new Error("Refusing to replace an installed helper with an unsigned local build. Set PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 for this deliberate development-mode migration.");
		}

		const tempRoot = await fileSystem.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-local-helper-"));
		const candidatePath = path.join(tempRoot, "pi-computer-use.app");
		try {
			const candidateExecutablePath = path.join(candidatePath, "Contents", "MacOS", "bridge");
			const candidateInfoPath = path.join(candidatePath, "Contents", "Info.plist");
			const candidateSourceHashPath = path.join(candidatePath, "Contents", "Resources", "source.sha256");
			const candidateIdentityMarkerPath = path.join(candidatePath, "Contents", "Resources", "signing-identity.sha1");
			const candidateBuildInputPath = path.join(candidatePath, "Contents", "Resources", "local-build-input.json");
			await fileSystem.mkdir(path.dirname(candidateExecutablePath), { recursive: true });
			await fileSystem.mkdir(path.dirname(candidateSourceHashPath), { recursive: true });
			await fileSystem.copyFile(sourcePath, candidateExecutablePath);
			await fileSystem.chmod(candidateExecutablePath, 0o755);
			await fileSystem.writeFile(candidateInfoPath, infoPlist);
			await fileSystem.writeFile(candidateSourceHashPath, `${sourceHash}\n`);
			await fileSystem.writeFile(candidateIdentityMarkerPath, `${signingIdentity}\n`);
			if (buildInputMetadata) await fileSystem.writeFile(candidateBuildInputPath, serializeLocalBuildInput(buildInputMetadata));
			await signBundle(candidatePath, signingIdentity);
			if (signingIdentity === "unsigned") {
				if (await readRequirement(candidatePath) !== unsignedDevelopmentRequirement) {
					throw new Error("The explicit unsigned local build unexpectedly has a code-signing requirement.");
				}
			} else {
				await verifySignature(candidatePath);
				if (await readRequirement(candidatePath) === unsignedDevelopmentRequirement) {
					throw new Error("The locally signed helper did not report a designated requirement.");
				}
				const candidateIdentity = await readInstalledIdentity(candidatePath);
				if (candidateIdentity !== signingIdentity) {
					throw helperIdentityError("ERR_LOCAL_SIGNING_IDENTITY_MISMATCH", "The locally built helper was signed by a different identity than the selected identity.");
				}
			}
			return await installPrebuiltHelperAppLocked(candidatePath, {
				installPath,
				fileSystem,
				verifySignature: localVerifySignature,
				readRequirement: localReadRequirement,
				readPinnedIdentity: async () => pinnedIdentity,
				checkIdentityAvailable,
				copyBundle,
				register,
				identityMigration: allowAdhocIdentityUpdate && (signingIdentity === "-" || signingIdentity === "unsigned") ? "explicit-ad-hoc" : undefined,
			});
		} finally {
			await fileSystem.rm(tempRoot, { force: true, recursive: true }).catch(() => {});
		}
	};
	return updateLockHeld ? install() : withHelperUpdateLock(installPath, install, lockOptions);
}

export async function installLocalMacBuild({
	arch,
	installPath = helperAppPath,
	fileSystem = fs,
	getVersion = packageVersion,
	resolveSigningIdentity = () => process.env.PI_COMPUTER_USE_NO_SIGN === "1" ? "unsigned" : resolveCodeSignIdentity(),
	signBundle = (appPath, identity) => signHelperWithIdentity(appPath, helperBundleId, identity),
	verifySignature = (appPath) => run("codesign", ["--verify", "--strict", appPath]),
	readRequirement = readDesignatedRequirement,
	readInstalledIdentity = readInstalledSigningIdentity,
	readPinnedIdentity = readPinnedSigningIdentity,
	checkIdentityAvailable = identityIsAvailable,
	copyBundle = (source, destination) => run("/usr/bin/ditto", [source, destination]),
	register = (appPath) => registerHelperApp(appPath),
	lockOptions = { waitMs: 60_000, staleMs: 30_000, retryMs: 100 },
	allowAdhocIdentityUpdate = allowAdhocUpdate,
	compileHelper = buildHelper,
	buildInputProvider = (targetArch, options) => createLocalMacBuildInput(targetArch, options),
	buildInputOptions = {},
} = {}) {
	arch = normalizeArch(arch);
	installPath = path.resolve(installPath);
	const install = async () => {
		const localReadRequirement = async (appPath) => {
			try {
				return await readRequirement(appPath);
			} catch {
				return unsignedDevelopmentRequirement;
			}
		};
		const localVerifySignature = async (appPath) => {
			if (await localReadRequirement(appPath) !== unsignedDevelopmentRequirement) await verifySignature(appPath);
		};
		await recoverPendingHelperUpdate(installPath, {
			fileSystem,
			verifySignature: localVerifySignature,
			readRequirement: localReadRequirement,
		});

		const version = await getVersion();
		const buildInput = await buildInputProvider(arch, { ...buildInputOptions, getVersion: async () => version });
		const expectedInfo = helperInfoPlist(version);
		const installedExists = await pathExists(fileSystem, installPath);
		const pinnedIdentity = await readPinnedIdentity();
		if (pinnedIdentity && !(await checkIdentityAvailable(pinnedIdentity))) {
			throw helperIdentityError(
				"ERR_PINNED_HELPER_IDENTITY_UNAVAILABLE",
				"The pinned macOS signing identity certificate is unavailable. Restore that certificate before building a replacement; the installed app was preserved.",
			);
		}
		const signingIdentity = await resolveSigningIdentity();
		if (pinnedIdentity && signingIdentity !== pinnedIdentity) {
			throw helperIdentityError(
				"ERR_HELPER_IDENTITY_MISMATCH",
				"The selected macOS signing identity differs from the pinned helper identity. The installed app was preserved.",
			);
		}

		const buildInputPath = path.join(installPath, "Contents", "Resources", "local-build-input.json");
		const [installedInfo, installedBuildInput] = installedExists
			? await Promise.all([
				fileSystem.readFile(path.join(installPath, "Contents", "Info.plist"), "utf8").catch(() => undefined),
				fileSystem.readFile(buildInputPath, "utf8").catch(() => undefined),
			])
			: [];
		const expectedBuildInput = serializeLocalBuildInput(buildInput);
		if (
			installedExists && pinnedIdentity && signingIdentity === pinnedIdentity &&
			installedInfo === expectedInfo && installedBuildInput === expectedBuildInput
		) {
			await verifySignature(installPath);
			const [installedRequirement, installedIdentity, identityMarker] = await Promise.all([
				localReadRequirement(installPath),
				readInstalledIdentity(installPath),
				fileSystem.readFile(path.join(installPath, "Contents", "Resources", "signing-identity.sha1"), "utf8").catch(() => undefined),
			]);
			if (installedRequirement === unsignedDevelopmentRequirement || installedIdentity !== pinnedIdentity || identityMarker?.trim() !== pinnedIdentity) {
				throw helperIdentityError(
					"ERR_HELPER_IDENTITY_MISMATCH",
					"The installed local helper does not strictly match the pinned signing identity. The installed app was preserved.",
				);
			}
			await register(installPath);
			return false;
		}

		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-local-build-"));
		const outputPath = path.join(tempRoot, "bridge");
		try {
			await compileHelper(arch, outputPath);
			return await installLocalHelperBinary(outputPath, {
				installPath,
				fileSystem,
				getVersion: async () => version,
				resolveSigningIdentity: async () => signingIdentity,
				signBundle,
				verifySignature,
				readRequirement,
				readInstalledIdentity,
				readPinnedIdentity: async () => pinnedIdentity,
				checkIdentityAvailable,
				copyBundle,
				register,
				lockOptions,
				allowAdhocIdentityUpdate,
				buildInputMetadata: buildInput,
				updateLockHeld: true,
			});
		} finally {
			await fs.rm(tempRoot, { force: true, recursive: true }).catch(() => {});
		}
	};
	return await withHelperUpdateLock(installPath, install, lockOptions);
}

async function installHelperApp(sourcePath) {
	return installLocalHelperBinary(sourcePath);
}

async function buildHelper(arch, outputPath) {
	for (const sourcePath of helperSourcePaths) {
		if (!(await exists(sourcePath))) throw new Error(`Native helper source not found at ${sourcePath}`);
	}

	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	const swiftArgs = helperCompilerArgs(arch, { outputPath, moduleCache: moduleCachePath(arch) });

	await run("xcrun", swiftArgs);
	await fs.chmod(outputPath, 0o755);
}

function windowsBinaryPath() {
	const releaseDir = path.join(windowsCrateDir, "target", "release");
	return {
		exePath: path.join(releaseDir, "windows-bridge.exe"),
		binPath: path.join(releaseDir, "windows-bridge"),
	};
}

async function setupWindowsHelper() {
	const prebuiltPath = path.join(rootDir, "prebuilt", "windows", "windows-bridge.exe");
	if (await exists(prebuiltPath)) {
		const { changed } = await copyIfChanged(prebuiltPath, windowsHelperDestPath);
		console.log(changed
			? `[pi-computer-use] installed Windows helper from prebuilt to ${windowsHelperDestPath}`
			: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`);
		return;
	}

	if (allowBuildFallback) {
		console.log("[pi-computer-use] Windows prebuilt helper missing; attempting source build with cargo...");
		await run("cargo", ["build", "--release", "--manifest-path", path.join(windowsCrateDir, "Cargo.toml")]);
		const { exePath, binPath } = windowsBinaryPath();
		const cargoOutput = (await exists(exePath)) ? exePath : (await exists(binPath)) ? binPath : exePath;
		const { changed } = await copyIfChanged(cargoOutput, windowsHelperDestPath);
		console.log(changed
			? `[pi-computer-use] built and installed Windows helper at ${windowsHelperDestPath}`
			: `[pi-computer-use] Windows helper already up to date at ${windowsHelperDestPath}`);
		return;
	}

	throw new Error(
		`No Windows prebuilt helper found at ${prebuiltPath}. ` +
			"Run 'node scripts/build-native.mjs --platform windows' to build, or set PI_COMPUTER_USE_ALLOW_BUILD=1 to build at install time.",
	);
}

async function setupLinuxHelper() {
	const arch = normalizeArch(process.arch);
	const prebuiltPath = path.join(rootDir, "prebuilt", "linux", arch, "linux-bridge");
	if (await exists(prebuiltPath)) {
		const { changed } = await copyIfChanged(prebuiltPath, linuxHelperDestPath);
		console.log(changed ? `[pi-computer-use] installed Linux helper (${arch}) from prebuilt to ${linuxHelperDestPath}` : `[pi-computer-use] Linux helper already up to date at ${linuxHelperDestPath}`);
		return;
	}
	if (allowLinuxBuildFallback) {
		if (process.platform !== "linux") throw new Error("The Linux helper source fallback must be built on Linux.");
		console.log("[pi-computer-use] Linux prebuilt helper missing; attempting source build with cargo...");
		await run("cargo", ["build", "--release", "--manifest-path", path.join(linuxCrateDir, "Cargo.toml")]);
		const cargoOutput = path.join(linuxCrateDir, "target", "release", "linux-bridge");
		const { changed } = await copyIfChanged(cargoOutput, linuxHelperDestPath);
		console.log(changed ? `[pi-computer-use] built and installed Linux helper at ${linuxHelperDestPath}` : `[pi-computer-use] Linux helper already up to date at ${linuxHelperDestPath}`);
		return;
	}
	throw new Error(`No Linux prebuilt helper found for ${arch} at ${prebuiltPath}. Run node scripts/build-native.mjs --platform linux to build, or set PI_COMPUTER_USE_ALLOW_BUILD=1 to build at install time.`);
}

async function setup() {
	const explicitPlatform = getArg("--platform");
	if (explicitPlatform === "windows" || (!explicitPlatform && process.platform === "win32")) {
		await setupWindowsHelper();
		return;
	}
	if (explicitPlatform === "linux" || (!explicitPlatform && process.platform === "linux")) {
		await setupLinuxHelper();
		return;
	}

	if (process.platform !== "darwin") {
		if (isPostinstall) {
			console.warn("[pi-computer-use] skipping helper setup: platform is not macOS.");
			return;
		}
		throw new Error("pi-computer-use helper is supported on macOS, Windows, and Linux. Use the matching --platform option.");
	}

	const arch = normalizeArch(process.arch);
	// Prefer the release-signed universal bundle (one artifact for both
	// arches, produced by .github/workflows/release.yml) over
	// per-arch bundles, over loose binaries (dev fallback).
	const universalAppPath = prebuiltAppPathForArch("universal");
	const prebuiltAppPath = (await exists(universalAppPath))
		? universalAppPath
		: prebuiltAppPathForArch(arch);
	const prebuiltPath = prebuiltPathForArch(arch);
	const prebuiltAppExists = await exists(prebuiltAppPath);
	const prebuiltExists = await exists(prebuiltPath);
	if (forceLocalMacBuild) {
		console.log("[pi-computer-use] explicit local build selected; release/prebuilt helper candidates are skipped.");
		const installed = await installLocalMacBuild({ arch });
		console.log(installed
			? `[pi-computer-use] installed locally built helper at ${helperAppPath}`
			: `[pi-computer-use] locally built helper already current at ${helperAppPath}`);
		return;
	}

	if (prebuiltAppExists) {
		const installed = await installPrebuiltHelperApp(prebuiltAppPath);
		console.log(
			installed
				? `[pi-computer-use] installed pre-signed helper app (${arch}) at ${helperAppPath}`
				: `[pi-computer-use] pre-signed helper app (${arch}) already current at ${helperAppPath}`,
		);
		return;
	}

	if (prebuiltExists) {
		const installed = await installHelperApp(prebuiltPath);
		console.log(
			installed
				? `[pi-computer-use] installed helper app (${arch}) at ${helperAppPath}`
				: `[pi-computer-use] helper app (${arch}) already current at ${helperAppPath}`,
		);
		return;
	}

	let releaseHelper;
	try {
		releaseHelper = await downloadReleaseHelperApp();
	} catch (error) {
		console.warn(`[pi-computer-use] signed helper release download unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (releaseHelper) {
		try {
			const installed = await installPrebuiltHelperApp(releaseHelper.appPath);
			console.log(
				installed
					? `[pi-computer-use] installed signed helper app from GitHub Release ${releaseHelper.tag} (${releaseHelper.assetName}) at ${helperAppPath}`
					: `[pi-computer-use] signed helper app from GitHub Release ${releaseHelper.tag} (${releaseHelper.assetName}) already current at ${helperAppPath}`,
			);
		} finally {
			await fs.rm(releaseHelper.tempDir, { force: true, recursive: true }).catch(() => {});
		}
		return;
	}

	if (allowBuildFallback) {
		const tempPath = path.join(os.tmpdir(), `pi-computer-use-bridge-${process.pid}-${Date.now()}`);
		try {
			console.log("[pi-computer-use] prebuilt helper missing; attempting source build with xcrun swiftc...");
			await buildHelper(arch, tempPath);
			const installed = await installHelperApp(tempPath);
			console.log(
				installed
					? `[pi-computer-use] built helper app at ${helperAppPath}`
					: `[pi-computer-use] built helper app; installed app already current at ${helperAppPath}`,
			);
		} finally {
			await fs.rm(tempPath, { force: true }).catch(() => {});
		}
		return;
	}

	throw new Error(
		`No prebuilt helper found for ${arch} at ${prebuiltPath}. Run 'npm run build:native' to build locally.`,
	);
}

const isMain = process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) setup().catch((error) => {
	if (isPostinstall) {
		console.warn(`[pi-computer-use] postinstall helper setup skipped: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(0);
	}

	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
