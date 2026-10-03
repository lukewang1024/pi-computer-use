import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const HELPER_PROTOCOL_VERSION = 6;

export async function executableSha256(filePath: string): Promise<string> {
	return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

/** Follow setup-helper's candidate order, without installing or fetching anything. */
export async function packagedHelperSha256(packageRoot: string, arch = process.arch): Promise<string> {
	const paths = [
		path.join(packageRoot, "prebuilt", "macos", "universal", "pi-computer-use.app", "Contents", "MacOS", "bridge"),
		path.join(packageRoot, "prebuilt", "macos", arch, "pi-computer-use.app", "Contents", "MacOS", "bridge"),
		path.join(packageRoot, "prebuilt", "macos", arch, "bridge"),
	];
	for (const candidate of paths) {
		try { return await executableSha256(candidate); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}
	throw new Error("No packaged macOS helper is available for build identity verification. Build or install the native package first.");
}

export function helperIdentityMatches(protocol: number, executableMatches: boolean, expectedSha256: string, runningSha256?: string): boolean {
	return protocol === HELPER_PROTOCOL_VERSION && executableMatches && /^[a-f0-9]{64}$/.test(expectedSha256) && runningSha256 === expectedSha256;
}
