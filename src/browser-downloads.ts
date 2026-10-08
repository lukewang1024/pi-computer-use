import path from "node:path";
import { lstat, mkdtemp } from "node:fs/promises";

// Machine-local integration setting, never a caller-supplied tool parameter.
// The host provisions and authorizes the parent; artifacts remain until an
// explicit digest-guarded filesystem operation removes them.
export async function prepareManagedDownloadDirectory(root: string | undefined): Promise<string | undefined> {
	if (root === undefined) return undefined;
	if (!root || root.includes("\0") || !path.isAbsolute(root)) {
		throw new Error("PI_COMPUTER_USE_DOWNLOAD_ROOT must be an existing absolute directory.");
	}
	const metadata = await lstat(root);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
		throw new Error("Managed download root must be a directory, not a redirected leaf.");
	}
	return await mkdtemp(path.join(root, "browser-"));
}
