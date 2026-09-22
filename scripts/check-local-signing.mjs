#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
	ensureIdentityOnce,
	parseCodeSigningIdentities,
	parseCodeSigningIdentityEntries,
	selectLocalCodeSigningIdentity,
	withDirectoryLock,
} from "./setup-helper.mjs";

const sample = `
Policy: Code Signing
  Matching identities
  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "pi-computer-use Local Signing (com.injaneity.pi-computer-use)" (CSSMERR_TP_NOT_TRUSTED)
  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB "pi-computer-use Local Signing" (CSSMERR_TP_NOT_TRUSTED)
  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "pi-computer-use Local Signing (com.injaneity.pi-computer-use)" (CSSMERR_TP_NOT_TRUSTED)
     3 identities found
`;

assert.deepEqual(parseCodeSigningIdentities(sample), [
	"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
]);
assert.deepEqual(parseCodeSigningIdentityEntries(sample).map(({ fingerprint }) => fingerprint), [
	"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
	"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
]);

const staleAppIdentity = "FDB6C14538DD248EE3B13690AE279D75F26625D0";
const workbenchA = "C0C10A2E84962733897563F882147CC3B6763A1C";
const workbenchB = "85EA403B3A6D59ED0B0DF838D9826B90BF3FC2C9";
const identityList = (rows) => rows.map(([fingerprint, name], index) => `  ${index + 1}) ${fingerprint} "${name}"`).join("\n");
const localName = "pi-computer-use Local Signing (com.injaneity.pi-computer-use)";
const workbenchName = "Workbench Local Development";
assert.equal(
	selectLocalCodeSigningIdentity(
		identityList([[workbenchA, workbenchName], [workbenchB, workbenchName]]),
		identityList([[staleAppIdentity, localName], [workbenchA, workbenchName], [workbenchB, workbenchName]]),
	),
	workbenchB,
	"select a valid identity deterministically instead of an untrusted same-name keychain entry",
);
assert.equal(
	selectLocalCodeSigningIdentity("", identityList([[workbenchA, workbenchName], [staleAppIdentity, localName]])),
	staleAppIdentity,
	"retain compatibility with an existing app-specific signing identity only as fallback",
);

const setupCopy = await fs.readFile(new URL("./setup-helper.mjs", import.meta.url), "utf8");
assert.doesNotMatch(setupCopy, /tccutil[\s\S]{0,80}reset|resetTcc/i);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-computer-use-signing-test-"));
const lockPath = path.join(tempDir, "identity.lock");
let identity;
let createCount = 0;

try {
	const results = await Promise.all(Array.from({ length: 12 }, () => ensureIdentityOnce(
		async () => identity,
		async () => {
			createCount++;
			await new Promise((resolve) => setTimeout(resolve, 20));
			identity = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
			return identity;
		},
		(callback) => withDirectoryLock(lockPath, callback, { waitMs: 2_000, retryMs: 5 }),
	)));

	assert.equal(createCount, 1, "concurrent callers must create only one identity");
	assert.deepEqual(new Set(results), new Set([identity]));

	const expiredLiveLock = path.join(tempDir, "expired-live-owner.lock");
	await fs.mkdir(expiredLiveLock);
	const liveOwner = { token: "live-owner-token", pid: process.pid, host: os.hostname() };
	await fs.writeFile(path.join(expiredLiveLock, "owner.json"), `${JSON.stringify(liveOwner)}\n`);
	const oldTime = new Date(Date.now() - 10_000);
	await fs.utimes(expiredLiveLock, oldTime, oldTime);
	await fs.utimes(path.join(expiredLiveLock, "owner.json"), oldTime, oldTime);
	let expiredLiveCallbackRan = false;
	await assert.rejects(
		withDirectoryLock(expiredLiveLock, async () => { expiredLiveCallbackRan = true; }, {
			waitMs: 30,
			staleMs: 1,
			retryMs: 5,
			heartbeatMs: 0,
		}),
		(error) => error.code === "ERR_DIRECTORY_LOCK_BUSY",
		"an alive owner with an expired heartbeat must be reported busy, never taken over",
	);
	assert.equal(expiredLiveCallbackRan, false);
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(expiredLiveLock, "owner.json"), "utf8")), liveOwner);
	await fs.rm(expiredLiveLock, { recursive: true, force: true });

	const heartbeatLock = path.join(tempDir, "owner-heartbeat.lock");
	await withDirectoryLock(heartbeatLock, async () => {
		const initialHeartbeat = (await fs.stat(path.join(heartbeatLock, "owner.json"))).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 35));
		assert.ok((await fs.stat(path.join(heartbeatLock, "owner.json"))).mtimeMs > initialHeartbeat,
			"the owner heartbeat must refresh the exact token-bearing record");
	}, { waitMs: 500, retryMs: 5, heartbeatMs: 5 });

	const guardedReleaseLock = path.join(tempDir, "guarded-release.lock");
	const replacementOwner = { token: "replacement-owner-token", pid: process.pid, host: os.hostname() };
	let replacementHeartbeatMtime;
	await withDirectoryLock(guardedReleaseLock, async () => {
		await fs.rename(guardedReleaseLock, `${guardedReleaseLock}.detached`);
		await fs.mkdir(guardedReleaseLock);
		const replacementOwnerPath = path.join(guardedReleaseLock, "owner.json");
		await fs.writeFile(replacementOwnerPath, `${JSON.stringify(replacementOwner)}\n`);
		await fs.utimes(replacementOwnerPath, oldTime, oldTime);
		replacementHeartbeatMtime = (await fs.stat(replacementOwnerPath)).mtimeMs;
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal((await fs.stat(replacementOwnerPath)).mtimeMs, replacementHeartbeatMtime,
			"an old heartbeat must not touch a replacement owner's token record");
	}, { waitMs: 500, retryMs: 5, heartbeatMs: 5 });
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(guardedReleaseLock, "owner.json"), "utf8")), replacementOwner,
		"an old owner's finally block must not delete a replacement owner's lock");
	assert.equal((await fs.stat(path.join(guardedReleaseLock, "owner.json"))).mtimeMs, replacementHeartbeatMtime,
		"an old owner's release must leave the replacement heartbeat untouched");
	await fs.rm(guardedReleaseLock, { recursive: true, force: true });
	await fs.rm(`${guardedReleaseLock}.detached`, { recursive: true, force: true });

	const deadOwnerLock = path.join(tempDir, "dead-owner-race.lock");
	await fs.mkdir(deadOwnerLock);
	const deadOwner = { token: "dead-owner-token", pid: process.pid + 10_000_000, host: os.hostname() };
	assert.throws(() => process.kill(deadOwner.pid, 0), (error) => error.code === "ESRCH", "synthetic dead-owner PID must not be live");
	await fs.writeFile(path.join(deadOwnerLock, "owner.json"), `${JSON.stringify(deadOwner)}\n`);
	const staleTime = new Date(Date.now() - 10_000);
	await fs.utimes(deadOwnerLock, staleTime, staleTime);
	await fs.utimes(path.join(deadOwnerLock, "owner.json"), staleTime, staleTime);
	let activeCallbacks = 0;
	let maxActiveCallbacks = 0;
	const deadOwnerResults = await Promise.all([1, 2].map((index) => withDirectoryLock(deadOwnerLock, async () => {
		activeCallbacks += 1;
		maxActiveCallbacks = Math.max(maxActiveCallbacks, activeCallbacks);
		await new Promise((resolve) => setTimeout(resolve, 30));
		activeCallbacks -= 1;
		return index;
	}, { waitMs: 2_000, staleMs: 1, retryMs: 2 })));
	assert.deepEqual(new Set(deadOwnerResults), new Set([1, 2]));
	assert.equal(maxActiveCallbacks, 1, "competing reclaimers must serialize and preserve the new owner's lock");
	assert.equal(await fs.access(deadOwnerLock).then(() => true, () => false), false);
	assert.equal(await fs.access(`${deadOwnerLock}.reaper`).then(() => true, () => false), false);
} finally {
	await fs.rm(tempDir, { force: true, recursive: true });
}

console.log("[check-local-signing] stable identity, live-owner heartbeat, token-safe release, dead-owner recovery, and concurrent creation passed");
