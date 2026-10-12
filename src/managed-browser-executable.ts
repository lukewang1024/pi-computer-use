import os from "node:os";
import paths from "node:path";
import type { ManagedBrowserKind } from "./config.ts";

export function managedBrowserOverrideName(browser: ManagedBrowserKind): string {
	return browser === "edge" ? "PI_COMPUTER_USE_EDGE_EXECUTABLE" : browser === "helium" ? "PI_COMPUTER_USE_HELIUM_EXECUTABLE" : "PI_COMPUTER_USE_CHROME_EXECUTABLE";
}

export function managedBrowserExecutableCandidates(browser: ManagedBrowserKind, options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): string[] {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const home = options.home ?? os.homedir();
	const path = platform === "win32" ? paths.win32 : paths.posix;
	const overrideName = managedBrowserOverrideName(browser);
	const override = env[overrideName]?.trim();
	if (override) return [path.resolve(override)];

	const platformCandidates = browser === "edge"
        ? platform === "darwin"
            ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", path.join(home, "Applications", "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge")]
            : platform === "win32"
                ? [env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"), env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"), env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe")]
                : ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"]
        : platform === "darwin"
		? browser === "helium"
			? [
				"/Applications/Helium.app/Contents/MacOS/Helium",
				path.join(home, "Applications", "Helium.app", "Contents", "MacOS", "Helium"),
			]
			: [
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				path.join(home, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
			]
		: platform === "win32"
			? browser === "helium"
				? [
					env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Helium", "Application", "helium.exe"),
					env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Helium", "Application", "helium.exe"),
				]
				: [
					env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
					env.PROGRAMFILES && path.join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
					env["PROGRAMFILES(X86)"] && path.join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
				]
			: browser === "helium"
				? [
					"/usr/bin/helium",
					"/usr/bin/helium-browser",
					"/opt/helium/chrome",
					path.join(home, ".local", "helium", "chrome"),
				]
				: [
					"/usr/bin/google-chrome",
					"/usr/bin/google-chrome-stable",
					"/usr/bin/chromium",
					"/usr/bin/chromium-browser",
					"/snap/bin/chromium",
				];
	const pathNames = browser === "edge"
        ? platform === "win32" ? ["msedge.exe"] : ["microsoft-edge", "microsoft-edge-stable"]
        : browser === "helium"
		? platform === "win32" ? ["helium.exe"] : ["helium", "helium-browser"]
		: platform === "win32" ? ["chrome.exe"] : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
	const pathCandidates = (env.PATH ?? "")
		.split(platform === "win32" ? ";" : ":")
		.filter(Boolean)
		.flatMap((directory) => pathNames.map((name) => path.join(directory, name)));
	return [...new Set([...platformCandidates.filter((candidate): candidate is string => Boolean(candidate)), ...pathCandidates])];
}

