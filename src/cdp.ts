// Minimal Chrome DevTools Protocol client.
//
// Opt-in: set PI_COMPUTER_USE_CDP_PORT to the --remote-debugging-port of a
// running Chromium-family browser. When active, navigate_browser uses
// Page.navigate (event-driven, no AppleScript) and recent console messages
// and uncaught exceptions are attached to tool results. Everything else
// keeps the AX/CGEvent path, so with the env var unset this module is inert.

import { randomUUID } from "node:crypto";
import { parseLookResponse, serializeOutline, type SerializedOutline } from "./outline.ts";

export interface CdpConsoleEntry {
	level: string;
	text: string;
}

export interface CdpPageContext {
	contextId: string;
	targetId: string;
	title: string;
	url: string;
}

export interface CdpRemoteFrameRoute {
	ancestor?: CdpRemoteFrameRoute;
	ownerBackendNodeId: number;
	frameId: string;
	loaderId: string;
	parentFrameId: string;
}

interface CdpAttachedFrame {
	route: CdpRemoteFrameRoute;
	sessionId: string;
	parentSessionId?: string;
	parentTargetId: string;
}

export interface CdpLocalFocusOwner { backendNodeId: number; frameId: string; }

export interface CdpSnapshotTarget {
	ref: string;
	source: "browser_ax";
	role: string;
	name: string;
	value?: string;
	actions: string[];
	backendNodeId?: number;
	frameRoute?: CdpRemoteFrameRoute;
	localFocusOwners?: CdpLocalFocusOwner[];
}

export interface CdpAccessibilityCoverage {
	framesObserved: number;
	framesUnavailable: number;
	readOnlyFrames?: number;
	framesTruncated: boolean;
	failed: boolean;
}

export interface CdpPageSnapshot {
	image?: CdpViewportImage;
	contextId: string;
	snapshotId: string;
	targetId: string;
	title: string;
	url: string;
	capturedAt: number;
	text: string;
	targets: CdpSnapshotTarget[];
	outline: SerializedOutline;
	diagnostics: {
		cdp: "connected";
		semanticCollection?: "skipped";
		targetCount: number;
		accessibilityCoverage?: CdpAccessibilityCoverage;
		/** Monotonic wall times. Parallel collection phases overlap. */
		timings?: Partial<Record<"discoveryMs" | "connectMs" | "textReadMs" | "accessibilityReadMs" | "imageCaptureMs" | "pixelCaptureMs" | "collectionMs" | "outlineBuildMs" | "snapshotMs" | "disconnectMs", number>>;
		browserResultTimings?: { restoreMs: number; diffMs: number; foldMs: number; resultBuildMs: number };
	};
}

export interface CdpViewportImage {
	data: string;
	mimeType: "image/png";
	width: number;
	height: number;
	cssWidth: number;
	cssHeight: number;
	pixelScale: number;
}

export interface CdpEvaluationResult {
	contextId: string;
	value: unknown;
}

/** Window frame in screen points, as reported by the AX side. */
export interface WindowFrame {
	x: number;
	y: number;
	w: number;
	h: number;
}

const CDP_MODIFIERS = new Set(["alt", "option", "control", "ctrl", "meta", "command", "cmd", "shift"]);
const CDP_NAMED_KEYS = new Set(["enter", "return", "tab", "escape", "esc", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown", "arrowleft", "arrowup", "arrowright", "arrowdown", "space", "spacebar"]);

export function validateCdpKeypressKeys(value: unknown): asserts value is string[] {
	if (!Array.isArray(value) || value.length === 0 || value.some(key => typeof key !== "string" || key.length === 0)) throw new Error("Browser keypress requires nonempty string keys.");
	for (const key of value) {
		const lower = key.toLowerCase();
		if (!CDP_MODIFIERS.has(lower) && !CDP_NAMED_KEYS.has(lower) && !/^f([1-9]|1\d|2[0-4])$/i.test(key) && !/^[ -~]$/.test(key)) throw new Error(`Unsupported browser key '${key}'. Use typeText for text.`);
	}
	if (value.every(key => CDP_MODIFIERS.has(key.toLowerCase()))) throw new Error("Browser keypress requires a base key; modifier-only input is unsupported.");
}

const COMMAND_TIMEOUT_MS = 5_000;
const CDP_CONTEXT_PREFIX = "browser:";
const NAVIGATE_LOAD_TIMEOUT_MS = 10_000;
const CONNECT_FAILURE_RETRY_MS = 5_000;
const CONSOLE_BUFFER_LIMIT = 20;
let nextBrowserElementRef = 1;

export class CdpTab {
	private disconnected = false;
	private disconnectHandler?: () => void;
	setDisconnectHandler(handler: (() => void) | undefined): void { this.disconnectHandler = handler; }
	private notifyDisconnected(): void {
		this.disconnected = true;
		const handler = this.disconnectHandler;
		this.disconnectHandler = undefined;
		handler?.();
	}
	async setManagedDownloadDirectory(downloadPath: string): Promise<void> {
		await this.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath, eventsEnabled: false });
	}
	private nextId = 1;
	private readonly pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void; sessionId?: string }>();
	private consoleBuffer: CdpConsoleEntry[] = [];
	private loadFired: (() => void) | undefined;
	readonly accessibilityCoverage: CdpAccessibilityCoverage = { framesObserved: 0, framesUnavailable: 0, readOnlyFrames: 0, framesTruncated: false, failed: false };

	private constructor(
		private readonly ws: WebSocket,
		readonly targetId: string,
		public title: string,
	) {}

	static async connect(wsUrl: string, targetId: string, title: string): Promise<CdpTab> {
		const ws = new WebSocket(wsUrl);
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`Timed out connecting to CDP target at ${wsUrl}`)), COMMAND_TIMEOUT_MS);
				ws.onopen = () => {
					clearTimeout(timer);
					resolve();
				};
				ws.onerror = () => {
					clearTimeout(timer);
					reject(new Error(`Failed to connect to CDP target at ${wsUrl}`));
				};
			});

			const tab = new CdpTab(ws, targetId, title);
			ws.onmessage = (event) => tab.handleMessage(String(event.data));
			ws.onclose = () => { tab.rejectAllPending(new Error("CDP connection closed.")); tab.notifyDisconnected(); };
			ws.onerror = () => { tab.rejectAllPending(new Error("CDP connection error.")); tab.notifyDisconnected(); };
			await tab.send("Runtime.enable");
			await tab.send("Page.enable");
			return tab;
		} catch (error) {
			try {
				ws.close();
			} catch {
				// already closed
			}
			throw error;
		}
	}

	get isOpen(): boolean {
		return !this.disconnected && this.ws.readyState === WebSocket.OPEN;
	}

	close(): void {
		this.disconnected = true;
		this.loadFired?.();
		this.loadFired = undefined;
		this.rejectAllPending(new Error("CDP connection closed."));
		try {
			this.ws.close();
		} catch {
			// already closed
		}
	}

	/** Evaluates a JS expression in the page and returns its primitive value. */
	async evaluate(expression: string): Promise<unknown> {
		const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, timeout: COMMAND_TIMEOUT_MS, awaitPromise: true });
		if (result?.exceptionDetails) {
			const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "page exception";
			throw new Error(`CDP evaluation failed: ${String(message).slice(0, 500)}`);
		}
		return result?.result?.value;
	}

	/** Captures this exact CDP page viewport; never uses the desktop foreground. */
	async captureViewport(): Promise<CdpViewportImage> {
		const [layout, deviceScale] = await Promise.all([
			this.send("Page.getLayoutMetrics"),
			this.evaluate("window.devicePixelRatio"),
		]);
		const viewport = layout.cssVisualViewport;
		const width = Number(viewport?.clientWidth);
		const height = Number(viewport?.clientHeight);
		const dpr = Number(deviceScale);
		if (![width, height, dpr, viewport?.pageX, viewport?.pageY].every(Number.isFinite)
			|| width <= 0 || height <= 0 || dpr <= 0) throw new Error("CDP viewport dimensions unavailable.");
		const pixelScale = Math.min(1, 1600 / width, 1600 / height);
		// The surface screenshot uses device pixels on Retina displays. Compare
		// CDP's device and CSS viewports instead of assuming that page DPR alone
		// describes the surface (DPR can also contain emulation/page scaling).
		let surfaceScale = 1;
		if (layout.visualViewport) {
			const physicalWidth = Number(layout.visualViewport.clientWidth);
			const physicalHeight = Number(layout.visualViewport.clientHeight);
			const horizontalScale = physicalWidth / width;
			const verticalScale = physicalHeight / height;
			if (![physicalWidth, physicalHeight, horizontalScale, verticalScale].every(Number.isFinite)
				|| physicalWidth <= 0 || physicalHeight <= 0
				|| Math.abs(horizontalScale - verticalScale) > 1 / Math.min(width, height)) {
				throw new Error("CDP device and CSS viewport scales are inconsistent.");
			}
			surfaceScale = horizontalScale;
		}
		const scale = pixelScale / surfaceScale;
		const screenshot = await this.send("Page.captureScreenshot", {
			format: "png", fromSurface: true, captureBeyondViewport: false,
			clip: { x: viewport.pageX, y: viewport.pageY, width, height, scale },
		});
		const data = screenshot.data;
		if (typeof data !== "string" || data.length > 16_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
			throw new Error("CDP returned invalid or excessive screenshot data.");
		}
		const png = Buffer.from(data, "base64");
		if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
			|| png.subarray(12, 16).toString() !== "IHDR") throw new Error("CDP screenshot is not a PNG.");
		const imageWidth = png.readUInt32BE(16);
		const imageHeight = png.readUInt32BE(20);
		if (!imageWidth || !imageHeight || imageWidth > 1601 || imageHeight > 1601) {
			throw new Error("CDP screenshot dimensions exceeded the viewport budget.");
		}
		if (Math.abs(imageWidth - width * pixelScale) > 1 || Math.abs(imageHeight - height * pixelScale) > 1) {
			throw new Error(`CDP screenshot dimensions do not match the requested viewport: PNG ${imageWidth}x${imageHeight}, CSS ${width}x${height}, requested scale ${pixelScale}, DPR ${dpr}.`);
		}
		return { data, mimeType: "image/png", width: imageWidth, height: imageHeight,
			cssWidth: width, cssHeight: height, pixelScale: imageWidth / width };
	}

	/** Read-only inspection of the exact remote frame owned by this page. */
	async inspectRemoteFrame(ownerBackendNodeId: number, probe?: { name: string; role: string }, budgetMs = 2_000, parent?: { sessionId: string; targetId: string; route?: CdpRemoteFrameRoute }, traversal?: { depth: number; frames: number; deadline: number }): Promise<{
		frameId: string; loaderId: string; parentFrameId?: string; nodes: any[]; viewport: any; frameOwnerQuad: number[]; nodeQuads?: number[][]; nestedObserved?: number; nestedUnavailable?: number; nestedReadOnly?: number; nestedTruncated?: boolean;
	}> {
		if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error("CDP remote frame inspection requires a finite positive budget.");
		if (parent && (!parent.sessionId || !parent.targetId)) throw new Error("CDP remote frame parent scope is invalid.");
		const deadline = Math.min(Date.now() + Math.min(budgetMs, 3_000), traversal?.deadline ?? Infinity);
		const walk = traversal ?? { depth: 0, frames: 0, deadline };
		const remaining = () => { const left = deadline - Date.now(); if (left <= 0) throw new Error("CDP remote frame inspection deadline exceeded."); return Math.min(1_000, left); };
		const described = await this.send("DOM.describeNode", { backendNodeId: ownerBackendNodeId }, remaining(), parent?.sessionId);
		const frameId = described.node?.frameId;
		if (described.node?.nodeName !== "IFRAME" || typeof frameId !== "string" || !frameId) throw new Error("CDP remote frame has no exact owner in this page.");
		const info = (await this.send("Target.getTargetInfo", { targetId: frameId }, remaining(), parent?.sessionId)).targetInfo;
		if (info?.targetId !== frameId || info.type !== "iframe" || (info.parentId && info.parentId !== (parent?.targetId ?? this.targetId))) throw new Error("CDP remote frame target is not owned by this page.");
		const attached = await this.send("Target.attachToTarget", { targetId: frameId, flatten: true }, remaining(), parent?.sessionId);
		const sessionId = attached.sessionId;
		if (typeof sessionId !== "string" || !sessionId) throw new Error("CDP remote frame session unavailable.");
		try {
			const tree = await this.send("Page.getFrameTree", {}, remaining(), sessionId);
			if (tree.frameTree?.frame?.id !== frameId) throw new Error("CDP remote frame session does not match its owner.");
			const loaderId = tree.frameTree.frame.loaderId;
			if (typeof loaderId !== "string" || !loaderId) throw new Error("CDP remote frame document identity unavailable.");
			const result = await this.send("Accessibility.getFullAXTree", {}, remaining(), sessionId);
			if (!Array.isArray(result.nodes)) throw new Error("CDP remote frame accessibility tree unavailable.");
			const viewport = (await this.send("Page.getLayoutMetrics", {}, remaining(), sessionId)).cssLayoutViewport;
			const box = await this.send("DOM.getBoxModel", { backendNodeId: ownerBackendNodeId }, remaining(), parent?.sessionId);
			const frameOwnerQuad = box.model?.content;
			if (!Array.isArray(frameOwnerQuad) || frameOwnerQuad.length !== 8 || !frameOwnerQuad.every(Number.isFinite)) throw new Error("CDP remote frame owner geometry unavailable.");
			let nodeQuads: number[][] | undefined;
			if (probe) {
				const matches = result.nodes.filter((node: any) => axString(node.name) === probe.name && axString(node.role) === probe.role && Number.isFinite(node.backendDOMNodeId));
				if (matches.length !== 1) throw new Error("CDP remote frame geometry probe is ambiguous.");
				nodeQuads = (await this.send("DOM.getContentQuads", { backendNodeId: matches[0].backendDOMNodeId }, remaining(), sessionId)).quads;
			}
			let nestedObserved = 0, nestedUnavailable = 0, nestedReadOnly = 0, nestedTruncated = false;
			const route: CdpRemoteFrameRoute | undefined = typeof info.parentFrameId === "string" && info.parentFrameId && (!parent || parent.route)
				? {ownerBackendNodeId, frameId, loaderId, parentFrameId:info.parentFrameId, ancestor:parent?.route} : undefined;
			const nodes = result.nodes.map((node: any) => ({ ...node, childIds: [...(node.childIds ?? [])], cuRemoteFrameRoute:route, cuReadOnlyRemote:!route }));
			const owners = nodes.filter((node: any) => /^iframe/i.test(axString(node.role)) && Number.isFinite(node.backendDOMNodeId));
			for (const owner of owners) {
				if (walk.depth >= 4 || walk.frames >= 12 || Date.now() >= deadline) { nestedTruncated = true; nestedUnavailable++; continue; }
				walk.frames++;
				try {
					const nestedWalk = { depth: walk.depth + 1, frames: walk.frames, deadline };
					let nested;
					try { nested = await this.inspectRemoteFrame(owner.backendDOMNodeId, undefined, remaining(), {sessionId, targetId: frameId, route}, nestedWalk); }
					finally { walk.frames = nestedWalk.frames; }
					if (nodes.length + nested.nodes.length > 20_000) { nestedTruncated = true; nestedUnavailable++; continue; }
					const ids = new Set(nested.nodes.map((node: any) => String(node.nodeId)));
					const prefix = (id: unknown) => `${nested.frameId}:${String(id)}`;
					for (const node of nested.nodes) {
						const root = !node.parentId || !ids.has(String(node.parentId));
						if (root) owner.childIds.push(prefix(node.nodeId));
						nodes.push({...node, nodeId: prefix(node.nodeId), parentId: root ? owner.nodeId : prefix(node.parentId), childIds: (node.childIds ?? []).map(prefix), cuReadOnlyRemote: node.cuReadOnlyRemote === true, cuRemoteFrameRoute: node.cuRemoteFrameRoute});
					}
					owner.cuNestedObserved = true;
					nestedObserved += 1 + (nested.nestedObserved ?? 0);
					nestedReadOnly += (nested.nodes[0]?.cuReadOnlyRemote === true ? 1 : 0) + (nested.nestedReadOnly ?? 0);
					nestedUnavailable += nested.nestedUnavailable ?? 0;
					nestedTruncated ||= nested.nestedTruncated ?? false;
				} catch { nestedUnavailable++; }
			}
			const current = await this.send("DOM.describeNode", { backendNodeId: ownerBackendNodeId }, remaining(), parent?.sessionId);
			if (current.node?.frameId !== frameId) throw new Error("CDP remote frame owner changed during inspection.");
			const finalTree = await this.send("Page.getFrameTree", {}, remaining(), sessionId);
			if (finalTree.frameTree?.frame?.id !== frameId || finalTree.frameTree.frame.loaderId !== loaderId) throw new Error("CDP remote frame document changed during inspection.");
			return { frameId, loaderId, parentFrameId: info.parentFrameId, nodes, viewport, frameOwnerQuad, nodeQuads, nestedObserved, nestedUnavailable, nestedReadOnly, nestedTruncated };
		} finally {
			await this.send("Target.detachFromTarget", { sessionId }, 1_000, parent?.sessionId).catch(() => {});
		}
	}

	async accessibilityTree(): Promise<unknown[]> {
		Object.assign(this.accessibilityCoverage, { framesObserved: 0, framesUnavailable: 0, readOnlyFrames: 0, framesTruncated: false, failed: false });
		const result = await this.send("Accessibility.getFullAXTree");
		const nodes: any[] = Array.isArray(result?.nodes) ? result.nodes.map((node: any) => ({ ...node, childIds: [...(node.childIds ?? [])] })) : [];
		const owners = nodes.filter((node) => /^iframe/i.test(axString(node.role)) && Number.isFinite(node.backendDOMNodeId));
		const seen = new Set<string>();
		const deadline = Date.now() + 3_000;
		const traversal = {depth:0, frames:0, deadline};
		const remaining = () => Math.max(1, Math.min(1_000, deadline - Date.now()));
		for (let index = 0; index < owners.length; index++) {
			if (traversal.frames >= 12 || Date.now() >= deadline) { this.accessibilityCoverage.framesTruncated = true; break; }
			const owner = owners[index];
			try {
				const described = await this.send("DOM.describeNode", { backendNodeId: owner.backendDOMNodeId }, remaining());
				const frameId = described.node?.frameId;
				if (typeof frameId !== "string" || !frameId) { this.accessibilityCoverage.framesUnavailable++; continue; }
				if (seen.has(frameId)) continue;
				seen.add(frameId);
				traversal.frames++;
				let child: any;
				let readOnlyRemote = false;
				let frameRoute: CdpRemoteFrameRoute | undefined;
				try { child = await this.send("Accessibility.getFullAXTree", { frameId }, remaining()); }
				catch (error) {
					if (!(error instanceof Error) || !/CDP error: Frame.*not found/.test(error.message)) throw error;
					const remote = await this.inspectRemoteFrame(owner.backendDOMNodeId, undefined, Math.max(1, deadline - Date.now()), undefined, traversal);
					if (remote.frameId !== frameId) throw new Error("CDP remote frame changed during observation.");
					child = { nodes: remote.nodes };
					this.accessibilityCoverage.framesObserved += remote.nestedObserved ?? 0;
					this.accessibilityCoverage.readOnlyFrames = (this.accessibilityCoverage.readOnlyFrames ?? 0) + (remote.nestedReadOnly ?? 0);

					this.accessibilityCoverage.framesTruncated ||= remote.nestedTruncated ?? false;
					readOnlyRemote = true;
					if (typeof remote.parentFrameId === "string" && remote.parentFrameId) frameRoute = { ownerBackendNodeId: owner.backendDOMNodeId, frameId, loaderId: remote.loaderId, parentFrameId: remote.parentFrameId };
				}

				if (!Array.isArray(child.nodes) || !child.nodes.length) { this.accessibilityCoverage.framesUnavailable++; continue; }
				if (nodes.length + child.nodes.length > 20_000) { this.accessibilityCoverage.framesTruncated = true; break; }
				const ids = new Set(child.nodes.map((node: any) => String(node.nodeId)));
				const prefix = (id: unknown) => `${frameId}:${String(id)}`;
				const children = child.nodes.map((node: any) => {
					const root = !node.parentId || !ids.has(String(node.parentId));
					if (root) owner.childIds.push(prefix(node.nodeId));
					return { ...node, nodeId: prefix(node.nodeId), parentId: root ? owner.nodeId : prefix(node.parentId),
						childIds: (node.childIds ?? []).map(prefix), cuLocalFocusOwners: readOnlyRemote ? undefined : [...(owner.cuLocalFocusOwners ?? []), {backendNodeId:owner.backendDOMNodeId, frameId}], cuReadOnlyRemote: node.cuReadOnlyRemote === true || (readOnlyRemote && !frameRoute), cuRemoteFrameRoute: node.cuReadOnlyRemote === true ? undefined : (node.cuRemoteFrameRoute ?? frameRoute) };
				});
				nodes.push(...children);
				const nestedOwners = children.filter((node: any) => /^iframe/i.test(axString(node.role)) && Number.isFinite(node.backendDOMNodeId));
				if (readOnlyRemote) {
					if (!frameRoute) this.accessibilityCoverage.readOnlyFrames = (this.accessibilityCoverage.readOnlyFrames ?? 0) + 1;
					// Backend IDs from another process cannot be resolved on the main
					// session. Nested remote ownership needs its own scoped routing.
					this.accessibilityCoverage.framesUnavailable += nestedOwners.filter((node: any) => !node.cuNestedObserved).length;
				} else owners.push(...nestedOwners);
				this.accessibilityCoverage.framesObserved++;
			} catch {
				// An out-of-process frame or a detached frame must not be merged
				// under a guessed target/session. Expose partial coverage instead.
				this.accessibilityCoverage.framesUnavailable++;
			}
		}
		return nodes;
	}

	async navigate(url: string): Promise<void> {
		const loaded = new Promise<void>((resolve) => {
			this.loadFired = resolve;
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await this.send("Page.navigate", { url }, 20_000);
			if (result.errorText) throw new Error(`Browser navigation failed: ${String(result.errorText).slice(0, 500)}`);
			// An acknowledgement and a completed load are separate events.
			await Promise.race([loaded, new Promise<void>((resolve) => { timer = setTimeout(resolve, NAVIGATE_LOAD_TIMEOUT_MS); })]);
		} finally {
			if (timer) clearTimeout(timer);
			this.loadFired = undefined;
		}
	}

	async clickBackendNode(backendNodeId: number): Promise<void> {
		await this.withBackendNode(backendNodeId, "function(){ this.scrollIntoView({block:'center', inline:'center'}); this.click(); }");
	}

	async pointerClickRemoteFrame(route: CdpRemoteFrameRoute, backendNodeId: number, button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<void> {
		if (route.ancestor) return this.pointerClickNestedRemoteFrame(route, backendNodeId, button, clickCount);
		const owner = await this.send("DOM.describeNode", { backendNodeId: route.ownerBackendNodeId });
		if (owner.node?.frameId !== route.frameId || owner.node.nodeName !== "IFRAME") throw new Error("Remote frame owner is stale. No input was sent.");
		const info = (await this.send("Target.getTargetInfo", { targetId: route.frameId })).targetInfo;
		if (info?.type !== "iframe" || info.targetId !== route.frameId || info.parentFrameId !== route.parentFrameId || (info.parentId && info.parentId !== this.targetId)) throw new Error("Remote frame target ownership is stale. No input was sent.");
		const sessionId = (await this.send("Target.attachToTarget", { targetId: route.frameId, flatten: true })).sessionId;
		if (typeof sessionId !== "string" || !sessionId) throw new Error("Remote frame session unavailable.");
		const group = `cu-remote-pointer-${randomUUID()}`;
		try {
			const verifyDocument = async () => {
				const tree = await this.send("Page.getFrameTree", {}, COMMAND_TIMEOUT_MS, sessionId);
				if (tree.frameTree?.frame?.id !== route.frameId || tree.frameTree.frame.loaderId !== route.loaderId) throw new Error("Remote frame document changed; remaining input was not sent. Do not replay the action.");
				const current = await this.send("DOM.describeNode", { backendNodeId: route.ownerBackendNodeId });
				if (current.node?.frameId !== route.frameId) throw new Error("Remote frame owner changed; remaining input was not sent.");
			};
			await verifyDocument();
			await this.withBackendNode(route.ownerBackendNodeId, "function(){this.scrollIntoView({block:'center',inline:'center'});}");
			await this.withBackendNode(backendNodeId, "function(){if(!this.isConnected||this.disabled||this.matches?.(':disabled')||this.getAttribute?.('aria-disabled')==='true')throw Error('Remote pointer target unavailable');this.scrollIntoView({block:'center',inline:'center'});}", [], sessionId);
			const box = await this.send("DOM.getBoxModel", { backendNodeId: route.ownerBackendNodeId });
			const frameQuad = box.model?.content;
			const dimensions = await this.send("Runtime.evaluate", { expression: "({width:innerWidth,height:innerHeight})", returnByValue: true }, COMMAND_TIMEOUT_MS, sessionId);
			if (dimensions.exceptionDetails) throw new Error("Remote viewport unavailable.");
			const { width, height } = dimensions.result?.value ?? {};
			const geometry = await this.send("DOM.getContentQuads", { backendNodeId }, COMMAND_TIMEOUT_MS, sessionId);
			const target = await this.send("DOM.resolveNode", { backendNodeId, objectGroup: group }, COMMAND_TIMEOUT_MS, sessionId);
			if (typeof target.object?.objectId !== "string") throw new Error("Remote pointer target unavailable.");
			for (const quad of (geometry.quads ?? []).slice(0, 16)) {
				if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) continue;
				const x = Math.round((quad[0]+quad[2]+quad[4]+quad[6])/4), y = Math.round((quad[1]+quad[3]+quad[5]+quad[7])/4);
				if (x < 0 || y < 0 || x >= width || y >= height) continue;
				const point = mapRemoteFramePoint(frameQuad, width, height, x, y);
				for (let count = 1; count <= clickCount; count++) {
					await verifyDocument();
					const hit = await this.hitAtViewportPoint(x, y, sessionId);
					const hitObject = await this.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId, objectGroup: group }, COMMAND_TIMEOUT_MS, sessionId);
					if (typeof hitObject.object?.objectId !== "string") throw new Error("Remote pointer hit target unavailable; remaining input was not sent.");
					const checked = await this.send("Runtime.callFunctionOn", { objectId: target.object.objectId, arguments: [{objectId:hitObject.object?.objectId}], returnByValue:true,
						functionDeclaration:"function(hit){if(!this.isConnected||this.disabled||this.matches?.(':disabled')||this.getAttribute?.('aria-disabled')==='true')return false;for(let n=hit;n;n=n.parentNode||n.host)if(n===this)return true;return false;}" }, COMMAND_TIMEOUT_MS, sessionId);
					const rootHit = await this.hitAtViewportPoint(point.x, point.y);
					if (checked.exceptionDetails || checked.result?.value !== true || rootHit.frameId !== route.parentFrameId || rootHit.backendNodeId !== route.ownerBackendNodeId) throw new Error("Remote pointer target or outer frame is occluded; remaining input was not sent.");
					const nextBox = await this.send("DOM.getBoxModel", { backendNodeId: route.ownerBackendNodeId });
					const nextGeometry = await this.send("DOM.getContentQuads", { backendNodeId }, COMMAND_TIMEOUT_MS, sessionId);
					if (JSON.stringify(nextBox.model?.content) !== JSON.stringify(frameQuad) || JSON.stringify(nextGeometry.quads) !== JSON.stringify(geometry.quads)) throw new Error("Remote pointer geometry changed; remaining input was not sent.");
					await verifyDocument();
					await this.mouseAt(point.x, point.y, "mousePressed", button, count);
					await this.mouseAt(point.x, point.y, "mouseReleased", button, count);
				}
				return;
			}
			throw new Error("Remote pointer has no visible target point. No input was sent.");
		} finally {
			await this.send("Runtime.releaseObjectGroup", {objectGroup:group}, 1_000, sessionId).catch(()=>{});
			await this.send("Target.detachFromTarget", {sessionId}, 1_000).catch(()=>{});
		}
	}

	private async pointerClickNestedRemoteFrame(route: CdpRemoteFrameRoute, backendNodeId: number, button: "left" | "right" | "middle", clickCount: number): Promise<void> {
		await this.withRemoteFrameDocument(route, async (sessionId, verify, _ownerSession, _focus, frames) => {
			const group = `cu-nested-pointer-${randomUUID()}`;
			try {
				for (const frame of frames) await this.withBackendNode(frame.route.ownerBackendNodeId, "function(){if(!this.isConnected)throw Error('Nested frame owner detached');this.scrollIntoView({block:'center',inline:'center'});}", [], frame.parentSessionId);
				await this.withBackendNode(backendNodeId, "function(){if(!this.isConnected||this.disabled||this.matches?.(':disabled')||this.getAttribute?.('aria-disabled')==='true')throw Error('Nested pointer target unavailable');this.scrollIntoView({block:'center',inline:'center'});}", [], sessionId);
				// Scrolling can update DOM geometry before a remote frame paints.
				// Wait for rendering opportunities in every owning renderer before
				// collecting the geometry that the existing hit checks will verify.
				await Promise.all([undefined, ...frames.map(frame => frame.sessionId)].map(async renderer => {
					const ready = await this.send("Runtime.evaluate", {
						expression: "new Promise(resolve=>{let first=0,second=0;const done=value=>{clearTimeout(timer);cancelAnimationFrame(first);cancelAnimationFrame(second);resolve(value)};const timer=setTimeout(()=>done(false),500);first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>done(true))})})",
						awaitPromise: true, returnByValue: true,
					}, 1_000, renderer);
					if (ready.exceptionDetails || ready.result?.value !== true) throw Error("Nested frame rendering was not ready; no pointer input was sent.");
				}));
				const geometry = await this.send("DOM.getContentQuads", {backendNodeId}, COMMAND_TIMEOUT_MS, sessionId);
				const target = await this.send("DOM.resolveNode", {backendNodeId, objectGroup:group}, COMMAND_TIMEOUT_MS, sessionId);
				if (typeof target.object?.objectId !== "string") throw new Error("Nested pointer target unavailable.");
				const layers = [];
				for (const frame of frames) {
					const box = await this.send("DOM.getBoxModel", {backendNodeId:frame.route.ownerBackendNodeId}, COMMAND_TIMEOUT_MS, frame.parentSessionId);
					const dimensions = await this.send("Runtime.evaluate", {expression:"({width:innerWidth,height:innerHeight})",returnByValue:true}, COMMAND_TIMEOUT_MS, frame.sessionId);
					if (dimensions.exceptionDetails) throw new Error("Nested viewport unavailable.");
					const {width,height} = dimensions.result?.value ?? {};
					mapRemoteFramePoint(box.model?.content, width, height, 0, 0);
					layers.push({frame,quad:box.model.content,width,height});
				}
				for (const quad of (geometry.quads ?? []).slice(0,16)) {
					if (!Array.isArray(quad)||quad.length!==8||!quad.every(Number.isFinite)) continue;
					const x=Math.round((quad[0]+quad[2]+quad[4]+quad[6])/4), y=Math.round((quad[1]+quad[3]+quad[5]+quad[7])/4);
					const leaf=layers.at(-1)!;
					if(x<0||y<0||x>=leaf.width||y>=leaf.height)continue;
					for(let count=1;count<=clickCount;count++){
						await verify();
						const hit=await this.hitAtViewportPoint(x,y,sessionId);
						const hitObject=await this.send("DOM.resolveNode",{backendNodeId:hit.backendNodeId,objectGroup:group},COMMAND_TIMEOUT_MS,sessionId);
						if(typeof hitObject.object?.objectId!=="string")throw Error("Nested pointer hit unavailable.");
						const checked=await this.send("Runtime.callFunctionOn",{objectId:target.object.objectId,arguments:[{objectId:hitObject.object.objectId}],returnByValue:true,functionDeclaration:"function(hit){if(!this.isConnected||this.disabled||this.matches?.(':disabled')||this.getAttribute?.('aria-disabled')==='true')return false;for(let n=hit;n;n=n.parentNode||n.host)if(n===this)return true;return false;}"},COMMAND_TIMEOUT_MS,sessionId);
						if(checked.exceptionDetails||checked.result?.value!==true)throw Error("Nested target is occluded; remaining input was not sent.");
						let point={x,y};
						for(const layer of [...layers].reverse()){
							if(point.x<0||point.y<0||point.x>=layer.width||point.y>=layer.height)throw Error("Nested pointer falls outside ancestor viewport.");
							point=mapRemoteFramePoint(layer.quad,layer.width,layer.height,point.x,point.y);
							const ownerHit=await this.hitAtViewportPoint(point.x,point.y,layer.frame.parentSessionId);
							if(ownerHit.frameId!==layer.frame.route.parentFrameId||ownerHit.backendNodeId!==layer.frame.route.ownerBackendNodeId)throw Error("Nested ancestor is occluded; remaining input was not sent.");
							await this.withBackendNode(layer.frame.route.ownerBackendNodeId, "function(x,y){const root=this.getRootNode();const hit=(root.elementFromPoint?root:this.ownerDocument).elementFromPoint(x,y);if(!this.isConnected||hit!==this)throw Error('Nested ancestor is occluded by renderer hit test; remaining input was not sent.');}", [point.x,point.y], layer.frame.parentSessionId);
							const next=await this.send("DOM.getBoxModel",{backendNodeId:layer.frame.route.ownerBackendNodeId},COMMAND_TIMEOUT_MS,layer.frame.parentSessionId);
							if(JSON.stringify(next.model?.content)!==JSON.stringify(layer.quad))throw Error("Nested ancestor geometry changed; remaining input was not sent.");
							const nextDimensions=await this.send("Runtime.evaluate",{expression:"({width:innerWidth,height:innerHeight})",returnByValue:true},COMMAND_TIMEOUT_MS,layer.frame.sessionId);
							if(nextDimensions.exceptionDetails||nextDimensions.result?.value?.width!==layer.width||nextDimensions.result?.value?.height!==layer.height)throw Error("Nested ancestor viewport changed; remaining input was not sent.");
						}
						const nextGeometry=await this.send("DOM.getContentQuads",{backendNodeId},COMMAND_TIMEOUT_MS,sessionId);
						if(JSON.stringify(nextGeometry.quads)!==JSON.stringify(geometry.quads))throw Error("Nested target geometry changed; remaining input was not sent.");
						await verify();
						await this.mouseAt(point.x,point.y,"mousePressed",button,count);
						await this.mouseAt(point.x,point.y,"mouseReleased",button,count);
					}
					return;
				}
				throw Error("Nested pointer has no visible target point. No input was sent.");
			}finally{await this.send("Runtime.releaseObjectGroup",{objectGroup:group},1000,sessionId).catch(()=>{});}
		});
	}

	private async hitAtViewportPoint(x: number, y: number, sessionId?: string): Promise<any> {
		const layout = await this.send("Page.getLayoutMetrics", {}, COMMAND_TIMEOUT_MS, sessionId);
		const viewport = layout.cssLayoutViewport;
		if (![x, y, viewport?.pageX, viewport?.pageY, viewport?.clientWidth, viewport?.clientHeight].every(Number.isFinite)) throw new Error("Pointer hit viewport is unavailable; no input was sent.");
		if (viewport.clientWidth <= 0 || viewport.clientHeight <= 0 || x < 0 || y < 0 || x >= viewport.clientWidth || y >= viewport.clientHeight) throw new Error("Pointer hit falls outside its owning viewport; remaining input was not sent. Do not replay the action.");
		const hit = await this.send("DOM.getNodeForLocation", {
			x: Math.round(x + viewport.pageX), y: Math.round(y + viewport.pageY),
			includeUserAgentShadowDOM: true, ignorePointerEventsNone: false,
		}, COMMAND_TIMEOUT_MS, sessionId);
		const current = await this.send("Page.getLayoutMetrics", {}, COMMAND_TIMEOUT_MS, sessionId);
		if (JSON.stringify(current.cssLayoutViewport) !== JSON.stringify(viewport)) throw new Error("Pointer hit viewport changed; remaining input was not sent. Do not replay the action.");
		return hit;
	}

	async pointerClickBackendNode(backendNodeId: number, button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<void> {
		await this.withBackendNode(backendNodeId, "function(){ if(!this.isConnected || this.disabled || this.matches?.(':disabled') || this.getAttribute?.('aria-disabled')==='true') throw Error('Exact pointer target is unavailable or disabled'); this.scrollIntoView({block:'center',inline:'center'}); }");
		const layout = await this.send("Page.getLayoutMetrics");
		const viewport = layout.cssLayoutViewport;
		if (![viewport?.clientWidth, viewport?.clientHeight, viewport?.pageX, viewport?.pageY].every(Number.isFinite)) throw new Error("CDP pointer viewport is unavailable.");
		const geometry = await this.send("DOM.getContentQuads", { backendNodeId });
		const quads: number[][] = Array.isArray(geometry.quads) ? geometry.quads : [];
		const group = `cu-pointer-${randomUUID()}`;
		try {
			const target = await this.send("DOM.resolveNode", { backendNodeId, objectGroup: group });
			const objectId = target?.object?.objectId;
			if (typeof objectId !== "string") throw new Error("CDP pointer target could not be resolved.");
			const hitIsExact = async (x: number, y: number): Promise<boolean> => {
				// DOM hit testing uses document coordinates; mouse dispatch and quads use viewport coordinates.
				const hit = await this.send("DOM.getNodeForLocation", { x: Math.round(x + viewport.pageX), y: Math.round(y + viewport.pageY), includeUserAgentShadowDOM: true, ignorePointerEventsNone: false });
				const hitNode = await this.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId, objectGroup: group });
				if (typeof hitNode?.object?.objectId !== "string") return false;
				const checked = await this.send("Runtime.callFunctionOn", {
					objectId, returnByValue: true,
					functionDeclaration: "function(hit){ if(!this.isConnected || this.disabled || this.matches?.(':disabled') || this.getAttribute?.('aria-disabled')==='true') return false; for(let node=hit;node;node=node.parentNode||node.host){if(node===this)return true;} return false; }",
					arguments: [{ objectId: hitNode.object.objectId }],
				});
				if (checked.exceptionDetails) throw new Error("CDP exact pointer hit check failed.");
				return checked.result?.value === true;
			};
			for (const quad of quads.slice(0, 16)) {
				if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) continue;
				const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4);
				const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
				if (x < 0 || y < 0 || x >= viewport.clientWidth || y >= viewport.clientHeight) continue;
				if (!(await hitIsExact(x, y))) continue;
				// Reject movement between geometry observation and dispatch. Never
				// turn a stale target into a click on its replacement or an overlay.
				const currentLayout = await this.send("Page.getLayoutMetrics");
				if (JSON.stringify(currentLayout.cssLayoutViewport) !== JSON.stringify(viewport)) throw new Error("CDP pointer viewport changed; observe it again. No input was sent.");
				const current = await this.send("DOM.getContentQuads", { backendNodeId });
				if (JSON.stringify(current.quads) !== JSON.stringify(geometry.quads)) throw new Error("CDP pointer target moved; observe it again. No input was sent.");
				for (let count = 1; count <= clickCount; count++) {
					if (count > 1) {
						const nextLayout = await this.send("Page.getLayoutMetrics");
						if (JSON.stringify(nextLayout.cssLayoutViewport) !== JSON.stringify(viewport)) throw new Error("CDP pointer viewport changed after an earlier click; remaining input was not sent. Do not replay the action.");
						const nextGeometry = await this.send("DOM.getContentQuads", { backendNodeId });
						if (JSON.stringify(nextGeometry.quads) !== JSON.stringify(geometry.quads) || !(await hitIsExact(x, y))) {
							throw new Error("CDP pointer target changed after an earlier click. Remaining input was not sent; do not replay the action.");
						}
					}
					await this.mouseAt(x, y, "mousePressed", button, count);
					await this.mouseAt(x, y, "mouseReleased", button, count);
				}
				return;
			}
			throw new Error("CDP exact pointer target is occluded or has no visible hit point. No input was sent.");
		} finally {
			await this.send("Runtime.releaseObjectGroup", { objectGroup: group }, 1_000).catch(() => {});
		}
	}


	private async withRemoteFrameDocument<T>(route: CdpRemoteFrameRoute, action: (sessionId: string, verify: () => Promise<void>, ownerSessionId: string | undefined, verifyOwnerFocus: () => Promise<void>, frames: readonly CdpAttachedFrame[]) => Promise<T>): Promise<T> {
		const chain: CdpRemoteFrameRoute[] = [];
		const seen = new Set<CdpRemoteFrameRoute>();
		for (let current: CdpRemoteFrameRoute | undefined = route; current; current = current.ancestor) {
			if (seen.has(current) || chain.length >= 5) throw new Error("Remote frame ancestor route is cyclic or excessive. No input was sent.");
			seen.add(current); chain.unshift(current);
		}
		const attached: CdpAttachedFrame[] = [];
		const deadline = Date.now() + 5_000;
		const remaining = () => {const left = deadline - Date.now(); if (left <= 0) throw new Error("Remote frame ancestor verification deadline exceeded. Do not replay input."); return Math.min(COMMAND_TIMEOUT_MS, left);};
		const verify = async () => {
			for (const entry of attached) {
				const tree = await this.send("Page.getFrameTree", {}, remaining(), entry.sessionId);
				const current = await this.send("DOM.describeNode", {backendNodeId: entry.route.ownerBackendNodeId}, remaining(), entry.parentSessionId);
				const info = (await this.send("Target.getTargetInfo", {targetId: entry.route.frameId}, remaining(), entry.parentSessionId)).targetInfo;
				if (tree.frameTree?.frame?.id !== entry.route.frameId || tree.frameTree.frame.loaderId !== entry.route.loaderId || current.node?.nodeName !== "IFRAME" || current.node.frameId !== entry.route.frameId || info?.type !== "iframe" || info.targetId !== entry.route.frameId || info.parentFrameId !== entry.route.parentFrameId || (info.parentId && info.parentId !== entry.parentTargetId)) throw new Error("Remote frame document or ancestor owner changed; remaining input was not sent. Do not replay the action.");
			}
		};
		try {
			for (const hop of chain) {
				await verify();
				const parentSessionId = attached.at(-1)?.sessionId;
				const parentTargetId = attached.at(-1)?.route.frameId ?? this.targetId;
				const owner = await this.send("DOM.describeNode", {backendNodeId: hop.ownerBackendNodeId}, remaining(), parentSessionId);
				const info = (await this.send("Target.getTargetInfo", {targetId: hop.frameId}, remaining(), parentSessionId)).targetInfo;
				if (owner.node?.nodeName !== "IFRAME" || owner.node.frameId !== hop.frameId || info?.type !== "iframe" || info.targetId !== hop.frameId || info.parentFrameId !== hop.parentFrameId || (info.parentId && info.parentId !== parentTargetId)) throw new Error("Remote frame ancestor ownership is stale. No input was sent.");
				const sessionId = (await this.send("Target.attachToTarget", {targetId: hop.frameId, flatten: true}, remaining(), parentSessionId)).sessionId;
				if (typeof sessionId !== "string" || !sessionId) throw new Error("Remote frame session unavailable.");
				attached.push({route: hop, sessionId, parentSessionId, parentTargetId});
			}
			await verify();
			const leaf = attached.at(-1)!;
			const verifyOwnerFocus = async () => {
				await verify();
				for (const entry of attached) {
					await this.withBackendNode(entry.route.ownerBackendNodeId, "function(){if(!this.isConnected||(this.getRootNode().activeElement||this.ownerDocument.activeElement)!==this)throw Error('Exact remote ancestor frame did not acquire focus');}", [], entry.parentSessionId);
				}
			};
			return await action(leaf.sessionId, verify, leaf.parentSessionId, verifyOwnerFocus, attached);
		} finally {
			for (const entry of attached.reverse()) await this.send("Target.detachFromTarget", {sessionId:entry.sessionId}, 1_000, entry.parentSessionId).catch(() => {});
		}
	}

	async typeIntoRemoteBackendNode(route: CdpRemoteFrameRoute, backendNodeId: number, text: string, replace: boolean): Promise<void> {
		await this.withRemoteFrameDocument(route, async (sessionId, verify, _ownerSessionId, verifyOwnerFocus) => {
			await verify();
			if (!replace) {
				await this.insertTextIntoBackendNode(backendNodeId, text, sessionId, verifyOwnerFocus);
				return;
			}
			await this.withBackendNode(backendNodeId, "function(text,replace){if(!this.isConnected||this.disabled||this.readOnly||this.matches?.(':disabled')||this.getAttribute?.('aria-disabled')==='true'||this.getAttribute?.('aria-readonly')==='true')throw Error('Exact remote text target is not editable');if(!('value' in this)&&!this.isContentEditable)throw Error('Exact remote text target is not editable');this.scrollIntoView({block:'center',inline:'center'});this.focus();if(!this.isConnected||(this.getRootNode().activeElement||this.ownerDocument.activeElement)!==this)throw Error('Exact remote text target did not acquire focus');if('value' in this){const next=(replace?'':this.value)+text;let setter,found=false,proto=Object.getPrototypeOf(this);for(let depth=0;proto&&depth<32;depth++,proto=Object.getPrototypeOf(proto)){const descriptor=Object.getOwnPropertyDescriptor(proto,'value');if(descriptor){setter=descriptor.set;found=true;break;}}if(proto&&!found)throw Error('Text value prototype chain exceeded safety limit');if(setter)setter.call(this,next);else this.value=next;}else this.textContent=(replace?'':this.textContent||'')+text;this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));this.dispatchEvent(new Event('change',{bubbles:true}));}", [text,replace], sessionId);
		});
	}

	async keypressRemoteBackendNode(route: CdpRemoteFrameRoute, backendNodeId: number, keys: string[]): Promise<void> {
		validateCdpKeypressKeys(keys);
		await this.withRemoteFrameDocument(route, async (sessionId, verify, _ownerSessionId, verifyOwnerFocus) => {
			await this.withBackendNode(backendNodeId, "function(){if(!this.isConnected||this.disabled||this.matches?.(':disabled'))throw Error('Exact remote keyboard target unavailable');this.scrollIntoView({block:'center',inline:'center'});this.focus();if((this.getRootNode().activeElement||this.ownerDocument.activeElement)!==this)throw Error('Exact remote keyboard target did not acquire focus');}", [], sessionId);
			const checkFocus = async () => {
				await verifyOwnerFocus();
				await this.withBackendNode(backendNodeId, "function(){if(!this.isConnected||(this.getRootNode().activeElement||this.ownerDocument.activeElement)!==this)throw Error('Exact remote keyboard target lost focus');}", [], sessionId);
			};
			await this.keypress(keys, undefined, sessionId, checkFocus);
		});
	}

	async typeIntoBackendNode(backendNodeId: number, text: string, replace: boolean, localFocusOwners: CdpLocalFocusOwner[] = []): Promise<void> {
		if (!replace) {
			await this.insertTextIntoBackendNode(backendNodeId, text, undefined, async () => {
				await this.verifyLocalFrameFocus(localFocusOwners);
			});
			return;
		}
		await this.withBackendNode(backendNodeId, "function(text, replace){ if(this.disabled || this.readOnly || this.matches?.(':disabled') || this.getAttribute?.('aria-disabled')==='true' || this.getAttribute?.('aria-readonly')==='true') throw Error('Exact text target is not editable'); this.scrollIntoView({block:'center', inline:'center'}); this.focus(); if ('value' in this) { const next=(replace?'':this.value)+text; let setter,found=false,proto=Object.getPrototypeOf(this);for(let depth=0;proto&&depth<32;depth++,proto=Object.getPrototypeOf(proto)){const descriptor=Object.getOwnPropertyDescriptor(proto,'value');if(descriptor){setter=descriptor.set;found=true;break;}}if(proto&&!found)throw Error('Text value prototype chain exceeded safety limit'); if(setter) setter.call(this,next); else this.value=next; } else this.textContent=(replace?'':this.textContent||'')+text; this.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text})); this.dispatchEvent(new Event('change', {bubbles:true})); }", [text, replace]);
	}

	private async verifyLocalFrameFocus(owners: CdpLocalFocusOwner[]): Promise<void> {
		if (!Array.isArray(owners) || owners.length > 12) throw Error("Local frame focus route is invalid");
		const seen = new Set<number>();
		for (const owner of owners) {
			if (!Number.isInteger(owner.backendNodeId) || owner.backendNodeId <= 0 || !owner.frameId || seen.has(owner.backendNodeId)) throw Error("Local frame focus route is invalid");
			seen.add(owner.backendNodeId);
			const current = await this.send("DOM.describeNode", {backendNodeId:owner.backendNodeId});
			if (current.node?.nodeName !== "IFRAME" || current.node.frameId !== owner.frameId) throw Error("Exact local frame owner changed; no text was sent");
			await this.withBackendNode(owner.backendNodeId, "function(){if(!this.isConnected||(this.getRootNode().activeElement||this.ownerDocument.activeElement)!==this)throw Error('Exact local frame ancestor lost focus');}");
		}
	}

	private async insertTextIntoBackendNode(backendNodeId: number, text: string, sessionId?: string, verifyOwnerFocus?: () => Promise<void>): Promise<void> {
		const focusCheck = "function(focus){if(!this.isConnected||this.disabled||this.readOnly||this.matches?.(':disabled')||this.getAttribute?.('aria-disabled')==='true'||this.getAttribute?.('aria-readonly')==='true'||(!('value' in this)&&!this.isContentEditable))throw Error('Exact text target is not editable');if(focus){this.scrollIntoView({block:'center',inline:'center'});this.focus();}if(!this.isConnected||(this.getRootNode().activeElement||this.ownerDocument.activeElement)!==this)throw Error('Exact text target did not retain focus');}";
		await this.withBackendNode(backendNodeId, focusCheck, [true], sessionId);
		if (verifyOwnerFocus) await verifyOwnerFocus();
		await this.withBackendNode(backendNodeId, focusCheck, [false], sessionId);
		// A failed/unknown write is never repeated or replaced by a JS setter.
		await this.send("Input.insertText", { text }, undefined, sessionId);
	}

	async scrollRemoteBackendNode(route: CdpRemoteFrameRoute, backendNodeId: number, deltaX: number, deltaY: number): Promise<void> {
		if (![deltaX, deltaY].every(Number.isFinite) || (deltaX === 0 && deltaY === 0)) throw new Error("Remote scroll requires a finite nonzero delta.");
		await this.withRemoteFrameDocument(route, async (sessionId, verify) => {
			await verify();
			await this.withBackendNode(backendNodeId, "function(dx,dy){if(!this.isConnected)throw Error('Remote scroll anchor is stale');const win=this.ownerDocument.defaultView;for(let n=this;n;n=n.parentElement||n.getRootNode?.().host){const style=win.getComputedStyle(n);if((dy&&n.scrollHeight>n.clientHeight&&/^(auto|scroll)$/.test(style.overflowY))||(dx&&n.scrollWidth>n.clientWidth&&/^(auto|scroll)$/.test(style.overflowX))){n.scrollBy({left:dx,top:dy,behavior:'instant'});return;}}win.scrollBy({left:dx,top:dy,behavior:'instant'});}", [deltaX,deltaY], sessionId);
		});
	}

	async scrollBy(deltaX: number, deltaY: number, backendNodeId?: number): Promise<void> {
		if (backendNodeId) {
			await this.withBackendNode(backendNodeId, "function(dx, dy){ this.scrollIntoView({block:'center', inline:'center'}); this.scrollBy(dx, dy); }", [deltaX, deltaY]);
			return;
		}
		await this.send("Runtime.evaluate", { expression: `window.scrollBy(${JSON.stringify(deltaX)}, ${JSON.stringify(deltaY)})` });
	}

	async typeIntoFocused(text: string): Promise<void> {
		await this.send("Input.insertText", { text });
	}

	async keypress(keys: string[], backendNodeId?: number, sessionId?: string, beforeKey?: () => Promise<void>): Promise<void> {
		validateCdpKeypressKeys(keys);
		if (backendNodeId !== undefined) {
			await this.withBackendNode(backendNodeId, "function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus(); const root=this.getRootNode(); if ((root.activeElement || this.ownerDocument.activeElement)!==this) throw Error('Exact keyboard target did not acquire focus'); }");
		}
		const modifierBits: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, command: 4, cmd: 4, shift: 8 };
		const modifiers = keys.reduce((bits, key) => bits | (modifierBits[key.toLowerCase()] ?? 0), 0);
		const named: Record<string, [string, number]> = {
			enter: ["Enter", 13], return: ["Enter", 13], tab: ["Tab", 9],
			escape: ["Escape", 27], esc: ["Escape", 27], backspace: ["Backspace", 8],
			delete: ["Delete", 46], insert: ["Insert", 45], home: ["Home", 36], end: ["End", 35],
			pageup: ["PageUp", 33], pagedown: ["PageDown", 34],
			arrowleft: ["ArrowLeft", 37], arrowup: ["ArrowUp", 38], arrowright: ["ArrowRight", 39], arrowdown: ["ArrowDown", 40],
			space: [" ", 32], spacebar: [" ", 32],
		};
		for (const key of keys.filter((candidate) => modifierBits[candidate.toLowerCase()] === undefined)) {
			const resolved = named[key.toLowerCase()];
			const baseValue = resolved?.[0] ?? key;
			const value = (modifiers & 8) !== 0 && /^[a-z]$/i.test(baseValue) ? baseValue.toUpperCase() : baseValue;
			const functionNumber = /^F([1-9]|1\d|2[0-4])$/i.exec(key);
			const virtualKey = resolved?.[1] ?? (functionNumber ? 111 + Number(functionNumber[1]) : /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : undefined);
			const code = value === " " ? "Space" : /^[a-z]$/i.test(value) ? `Key${value.toUpperCase()}` : /^\d$/.test(value) ? `Digit${value}` : functionNumber ? `F${functionNumber[1]}` : value;
			const text = (modifiers & ~8) === 0 ? value === "Enter" ? "\r" : value.length === 1 ? value : undefined : undefined;
			const fields = { key: value, code, modifiers, windowsVirtualKeyCode: virtualKey };
			if (beforeKey) await beforeKey();
			await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...fields, text }, COMMAND_TIMEOUT_MS, sessionId);
			await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...fields }, COMMAND_TIMEOUT_MS, sessionId);
		}
	}

	async mouseAt(x: number, y: number, type: "mouseMoved" | "mousePressed" | "mouseReleased", button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<void> {
		await this.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : button, clickCount });
	}

	async dragPath(path: Array<{ x: number; y: number }>): Promise<void> {
		if (path.length < 2) throw new Error("CDP drag requires at least two points.");
		await this.mouseAt(path[0].x, path[0].y, "mousePressed");
		for (const point of path.slice(1)) await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", buttons: 1 });
		const end = path[path.length - 1];
		await this.mouseAt(end.x, end.y, "mouseReleased");
	}

	private async withBackendNode(backendNodeId: number, functionDeclaration: string, args: unknown[] = [], sessionId?: string): Promise<void> {
		const resolved = await this.send("DOM.resolveNode", { backendNodeId }, COMMAND_TIMEOUT_MS, sessionId);
		const objectId = resolved?.object?.objectId;
		if (typeof objectId !== "string") throw new Error(`CDP could not resolve backend node ${backendNodeId}.`);
		try {
			const result = await this.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration,
				arguments: args.map((value) => ({ value })),
				returnByValue: true,
			}, COMMAND_TIMEOUT_MS, sessionId);
			if (result?.exceptionDetails) {
				const message = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "page exception";
				throw new Error(`CDP target operation failed: ${String(message).slice(0, 500)}`);
			}
		} finally {
			// A resolved node retains a remote object until explicitly released.
			// Navigation can destroy it first; cleanup must not mask an operation
			// error or make an already dispatched action appear safe to retry.
			await this.send("Runtime.releaseObject", { objectId }, 1_000, sessionId).catch(() => {});
		}
	}

	/** Screen bounds of the browser window containing this tab. */
	async windowBounds(): Promise<WindowFrame | undefined> {
		const result = await this.send("Browser.getWindowForTarget", { targetId: this.targetId });
		const bounds = result?.bounds;
		if (typeof bounds?.left !== "number" || typeof bounds?.width !== "number") return undefined;
		return { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
	}

	/** Returns buffered console messages/exceptions and clears the buffer. */
	drainConsole(): CdpConsoleEntry[] {
		const entries = this.consoleBuffer;
		this.consoleBuffer = [];
		return entries;
	}

	private send(method: string, params: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS, sessionId?: string): Promise<any> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP command '${method}' timed out after ${timeoutMs}ms.`));
			}, timeoutMs);
			this.pending.set(id, {
				sessionId,
				resolve: (result) => {
					clearTimeout(timer);
					resolve(result);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			try {
				this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private handleMessage(raw: string): void {
		let message: any;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}

		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.sessionId !== pending.sessionId) {
				pending.reject(new Error("CDP response belongs to a different target session."));
			} else if (message.error) {
				pending.reject(new Error(`CDP error: ${message.error.message ?? "unknown"}`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		// Child load/console events cannot settle or impersonate the main page.
		if (message.sessionId) return;
		switch (message.method) {
			case "Page.loadEventFired":
				this.loadFired?.();
				break;
			case "Runtime.consoleAPICalled": {
				const args = Array.isArray(message.params?.args) ? message.params.args : [];
				const text = args
					.map((arg: any) => (arg?.value !== undefined ? String(arg.value) : (arg?.description ?? "")))
					.filter(Boolean)
					.join(" ");
				this.pushConsole({ level: String(message.params?.type ?? "log"), text });
				break;
			}
			case "Runtime.exceptionThrown": {
				const details = message.params?.exceptionDetails;
				const text = details?.exception?.description ?? details?.text ?? "Uncaught exception";
				this.pushConsole({ level: "exception", text: String(text) });
				break;
			}
		}
	}

	private pushConsole(entry: CdpConsoleEntry): void {
		if (!entry.text) return;
		this.consoleBuffer.push(entry);
		if (this.consoleBuffer.length > CONSOLE_BUFFER_LIMIT) {
			this.consoleBuffer.shift();
		}
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}
}

const connectedTabs = new Map<string, CdpTab>();
const managedDownloadTabs = new Map<string, CdpTab>();
const connectingTabs = new Map<string, Promise<CdpTab>>();
let lastConnectFailureAt = 0;

/** Close session-owned CDP state without affecting the browser process. */
export function disconnectCdp(): void {
	for (const tab of managedDownloadTabs.values()) {
		tab.setDisconnectHandler(undefined);
		tab.close();
	}
	managedDownloadTabs.clear();
	for (const tab of connectedTabs.values()) tab.close();
	connectedTabs.clear();
	connectingTabs.clear();
	lastConnectFailureAt = 0;
}

function cdpEnabled(): boolean {
	const rawPort = process.env.PI_COMPUTER_USE_CDP_PORT ?? "";
	if (!/^\d+$/.test(rawPort)) return false;
	const port = Number(rawPort);
	return Number.isInteger(port) && port > 0 && port <= 65535 && typeof WebSocket !== "undefined";
}

/**
 * Returns a CDP connection to the tab matching the controlled window's title
 * (and, when provided, the window's screen frame), or undefined when CDP is
 * disabled, unreachable, or no tab matches. Reuses the cached connection
 * while it still matches; failures are cached briefly so an unreachable
 * endpoint never adds per-call latency.
 */
export async function cdpTabForWindow(windowTitle: string, frame?: WindowFrame): Promise<CdpTab | undefined> {
	if (!cdpEnabled()) return undefined;
	if (Date.now() - lastConnectFailureAt < CONNECT_FAILURE_RETRY_MS) return undefined;

	for (const tab of connectedTabs.values()) {
		if (tab.isOpen && titlesMatch(tab.title, windowTitle) && (await tabMatchesFrame(tab, frame))) return tab;
	}

	try {
		const pages = await cdpPages();
		const match = await pickTab(pages, windowTitle, frame);
		if (!match) return undefined;

		const existing = connectedTabs.get(match.id);
		if (existing?.isOpen) {
			existing.title = match.title;
			return existing;
		}
		let connecting = connectingTabs.get(match.id);
		if (!connecting) {
			connecting = CdpTab.connect(match.webSocketDebuggerUrl!, match.id, match.title);
			connectingTabs.set(match.id, connecting);
		}
		let connected: CdpTab;
		try {
			connected = await connecting;
		} finally {
			connectingTabs.delete(match.id);
		}
		connectedTabs.set(match.id, connected);
		return connected;
	} catch {
		lastConnectFailureAt = Date.now();
		return undefined;
	}
}

interface CdpPageTarget {
	id: string;
	type: string;
	title: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}

export async function listCdpPageContexts(): Promise<CdpPageContext[]> {
	const pages = await cdpPages();
	return pages.map((page) => ({
		contextId: cdpContextId(page.id),
		targetId: page.id,
		title: page.title,
		url: page.url ?? "",
	}));
}

export async function cdpClickForContext(contextId: string, backendNodeId: number): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.clickBackendNode(backendNodeId);
		return true;
	})) === true;
}

export async function cdpPointerClickForContext(contextId: string, backendNodeId: number, button: "left" | "right" | "middle" = "left", clickCount = 1, frameRoute?: CdpRemoteFrameRoute): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		if (frameRoute) await tab.pointerClickRemoteFrame(frameRoute, backendNodeId, button, clickCount);
		else await tab.pointerClickBackendNode(backendNodeId, button, clickCount);
		return true;
	})) === true;
}

export async function cdpTypeForContext(contextId: string, backendNodeId: number, text: string, replace: boolean, frameRoute?: CdpRemoteFrameRoute, localFocusOwners?: CdpLocalFocusOwner[]): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		if (frameRoute) await tab.typeIntoRemoteBackendNode(frameRoute, backendNodeId, text, replace);
		else await tab.typeIntoBackendNode(backendNodeId, text, replace, localFocusOwners);
		return true;
	})) === true;
}

export async function cdpScrollForContext(contextId: string, deltaX: number, deltaY: number, backendNodeId?: number, frameRoute?: CdpRemoteFrameRoute): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		if (frameRoute) {
			if (backendNodeId === undefined) throw new Error("Remote scroll requires an exact anchor node.");
			await tab.scrollRemoteBackendNode(frameRoute, backendNodeId, deltaX, deltaY);
		} else await tab.scrollBy(deltaX, deltaY, backendNodeId);
		return true;
	})) === true;
}

export async function cdpTypeFocusedForContext(contextId: string, text: string): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => { await tab.typeIntoFocused(text); return true; })) === true;
}

export async function cdpKeypressForContext(contextId: string, keys: string[], backendNodeId: number, frameRoute?: CdpRemoteFrameRoute): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => { if (frameRoute) await tab.keypressRemoteBackendNode(frameRoute, backendNodeId, keys); else await tab.keypress(keys, backendNodeId); return true; })) === true;
}

export async function cdpMouseForContext(contextId: string, x: number, y: number, type: "mouseMoved" | "mousePressed" | "mouseReleased", button: "left" | "right" | "middle" = "left", clickCount = 1): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => { await tab.mouseAt(x, y, type, button, clickCount); return true; })) === true;
}

export async function cdpDragForContext(contextId: string, path: Array<{ x: number; y: number }>): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => { await tab.dragPath(path); return true; })) === true;
}

export async function cdpNavigateContext(contextId: string, url: string): Promise<boolean> {
	return (await withCdpContextTab(contextId, async (tab) => {
		await tab.navigate(url);
		return true;
	})) === true;
}

export async function cdpSetManagedDownloadDirectory(contextId: string, downloadPath: string, onDisconnected: () => void): Promise<boolean> {
	if (managedDownloadTabs.has(contextId)) throw new Error("Managed download policy already configured; do not replay setup.");
	const page = await cdpPageForContext(contextId);
	if (!page?.webSocketDebuggerUrl) return false;
	const tab = await CdpTab.connect(page.webSocketDebuggerUrl, page.id, page.title);
	tab.setDisconnectHandler(onDisconnected);
	try {
		await tab.setManagedDownloadDirectory(downloadPath);
		if (!tab.isOpen) throw new Error("Managed download control disconnected during setup.");
		managedDownloadTabs.set(contextId, tab);
		return true;
	} catch (error) {
		tab.close();
		throw error;
	}
}

function assertManagedDownloadControl(contextId: string): void {
	const tab = managedDownloadTabs.get(contextId);
	if (tab && !tab.isOpen) throw new Error("Managed download control disconnected; do not replay browser input.");
}

export async function cdpEvaluateForContext(contextId: string, expression: string): Promise<CdpEvaluationResult | undefined> {
	assertManagedDownloadControl(contextId);
	const page = await cdpPageForContext(contextId);
	if (!page?.webSocketDebuggerUrl) return undefined;
	const tab = await CdpTab.connect(page.webSocketDebuggerUrl, page.id, page.title);
	try {
		return { contextId, value: await tab.evaluate(expression) };
	} finally {
		tab.close();
	}
}

export async function cdpCaptureForContext(contextId: string): Promise<CdpViewportImage | undefined> {
	return await withCdpContextTab(contextId, tab => tab.captureViewport());
}

/** Screenshot-only collection; document drift must never yield a usable state. */
export async function captureCdpPixelSnapshot(tab: Pick<CdpTab, "evaluate" | "captureViewport">): Promise<{
    image: CdpViewportImage; identity: { url: string; title: string; timeOrigin: number };
}> {
    const read = async () => {
        const raw = await tab.evaluate("({url:location.href,title:document.title,timeOrigin:performance.timeOrigin})");
        const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
        if (!value || typeof value.url !== "string" || !value.url || typeof value.title !== "string"
            || typeof value.timeOrigin !== "number" || !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0) {
            throw new Error("Browser pixel capture document identity unavailable");
        }
        return { url: value.url as string, title: value.title as string, timeOrigin: value.timeOrigin as number };
    };
    const before = await read();
    const image = await tab.captureViewport();
    const after = await read();
    if (before.url !== after.url || before.timeOrigin !== after.timeOrigin) {
        throw new Error("Browser document changed during pixel capture; observe again without replaying input");
    }
    return { image, identity: after };
}

export async function cdpSnapshotForContext(contextId: string, options: { includeImage?: boolean; includeOutline?: boolean } = {}): Promise<CdpPageSnapshot | undefined> {
	if (options.includeOutline === false && options.includeImage !== true) throw new Error("Pixel-only browser snapshot requires an image");
	const started = performance.now();
	const timings: NonNullable<CdpPageSnapshot["diagnostics"]["timings"]> = {};
	const measure = async <T>(key: keyof typeof timings, run: () => Promise<T>): Promise<T> => {
		const phaseStarted = performance.now();
		try { return await run(); }
		finally { timings[key] = performance.now() - phaseStarted; }
	};
	const page = await measure("discoveryMs", () => cdpPageForContext(contextId));
	if (!page?.webSocketDebuggerUrl) return undefined;

	const tab = await measure("connectMs", () => CdpTab.connect(page.webSocketDebuggerUrl!, page.id, page.title));
	try {
		const collectionStarted = performance.now();
		const pixels = options.includeOutline === false
			? await measure("pixelCaptureMs", () => captureCdpPixelSnapshot(tab)) : undefined;
		const [textValue, nodes, image] = await Promise.all([
			pixels ? Promise.resolve("") : measure("textReadMs", () => tab.evaluate("document.body ? document.body.innerText : ''")).catch(() => ""),
			pixels ? Promise.resolve([]) : measure("accessibilityReadMs", () => tab.accessibilityTree()).catch(() => { tab.accessibilityCoverage.failed = true; return []; }),
			pixels ? Promise.resolve(pixels.image) : options.includeImage ? measure("imageCaptureMs", () => tab.captureViewport()) : Promise.resolve(undefined),
		]);
		timings.collectionMs = performance.now() - collectionStarted;
		const snapshotId = randomUUID();
		const outlineStarted = performance.now();
		const { targets, outline } = cdpSnapshotOutline(snapshotId, nodes);
		timings.outlineBuildMs = performance.now() - outlineStarted;
		return {
			contextId,
			image,
			snapshotId,
			targetId: page.id,
			title: pixels?.identity.title ?? page.title,
			url: pixels?.identity.url ?? page.url ?? "",
			capturedAt: Date.now(),
			text: typeof textValue === "string" ? textValue : String(textValue ?? ""),
			targets,
			outline,
			diagnostics: { cdp: "connected", targetCount: targets.length, accessibilityCoverage: pixels ? undefined : { ...tab.accessibilityCoverage }, semanticCollection: pixels ? "skipped" : undefined, timings },
		};
	} finally {
		const disconnectStarted = performance.now();
		tab.close();
		timings.disconnectMs = performance.now() - disconnectStarted;
		timings.snapshotMs = performance.now() - started;
	}
}

async function withCdpContextTab<T>(contextId: string, run: (tab: CdpTab) => Promise<T>): Promise<T | undefined> {
	assertManagedDownloadControl(contextId);
	const page = await cdpPageForContext(contextId);
	if (!page?.webSocketDebuggerUrl) return undefined;
	const tab = await CdpTab.connect(page.webSocketDebuggerUrl, page.id, page.title);
	try {
		return await run(tab);
	} finally {
		tab.close();
	}
}

async function cdpPageForContext(contextId: string): Promise<CdpPageTarget | undefined> {
	if (!contextId.startsWith(CDP_CONTEXT_PREFIX)) return undefined;
	const targetId = contextId.slice(CDP_CONTEXT_PREFIX.length);
	const pages = await cdpPages();
	return pages.find((candidate) => candidate.id === targetId);
}

async function cdpPages(): Promise<CdpPageTarget[]> {
	if (!cdpEnabled()) return [];
	const port = process.env.PI_COMPUTER_USE_CDP_PORT;
	return discoverLocalCdpPages(port!);
}

/** Discovery alone may fall back between numeric loopback families; input is never replayed. */
export async function discoverLocalCdpPages(port: string): Promise<CdpPageTarget[]> {
	if (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid CDP port");
	let lastError: unknown;
	for (const host of ["127.0.0.1", "[::1]"]) {
		try {
			const response = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(1_000), redirect: "error" });
			if (!response.ok) throw new Error(`CDP discovery HTTP ${response.status}`);
			const targets = (await response.json()) as CdpPageTarget[];
			if (!Array.isArray(targets)) throw new Error("Invalid CDP target list");
			return targets.filter(target => target.type === "page" && target.webSocketDebuggerUrl && isLocalDebuggerWebSocket(target.webSocketDebuggerUrl, port)).map(target => {
				const url = new URL(target.webSocketDebuggerUrl!);
				url.hostname = host;
				return {...target, webSocketDebuggerUrl: url.toString()};
			});
		} catch (error) { lastError = error; }
	}
	throw lastError;

}

function cdpContextId(targetId: string): string {
	return `${CDP_CONTEXT_PREFIX}${targetId}`;
}

function axString(raw: any): string {
	const value = raw?.value ?? raw;
	return typeof value === "string" ? value.trim() : "";
}

export function cdpSnapshotOutline(snapshotId: string, nodes: unknown[]): { targets: CdpSnapshotTarget[]; outline: SerializedOutline } {
	const records = new Map<string, any>();
	for (const raw of nodes as any[]) {
		const nodeId = String(raw?.nodeId ?? "");
		if (nodeId) records.set(nodeId, raw);
	}
	const targets: CdpSnapshotTarget[] = [];
	const build = (raw: any, seen: Set<string>): any => {
		const nodeId = String(raw?.nodeId ?? randomUUID());
		if (seen.has(nodeId)) return undefined;
		seen.add(nodeId);
		const role = axString(raw?.role);
		const name = axString(raw?.name);
		const roleActions = browserActionsForAxRole(role);
		const properties = Array.isArray(raw?.properties) ? raw.properties : [];
		const hasFlag = (name: string): boolean => properties.some((property: any) => property?.name === name && property?.value?.value === true);
		const actions = raw?.cuReadOnlyRemote === true || raw?.ignored === true || hasFlag("disabled") ? []
			: hasFlag("readonly") ? roleActions.filter((action) => action !== "set_text") : roleActions;
		const backendNodeId = Number.isFinite(raw?.backendDOMNodeId) ? Math.trunc(raw.backendDOMNodeId) : undefined;
		const wireRef = `cdp:${nodeId}`;
		if (actions.length > 0 && name && (!actions.includes("click") || backendNodeId)) {
			targets.push({ ref: wireRef, source: "browser_ax", role, name, value: axString(raw?.value) || undefined, actions, backendNodeId, frameRoute: raw?.cuRemoteFrameRoute, localFocusOwners: raw?.cuLocalFocusOwners });
		}
		const childIds: string[] = Array.isArray(raw?.childIds) ? raw.childIds.map(String) : [];
		return {
			ref: wireRef,
			role,
			subrole: "",
			identifier: "",
			title: name,
			description: axString(raw?.description),
			value: axString(raw?.value),
			actions,
			canPress: actions.includes("click"),
			canFocus: actions.length > 0,
			canSetValue: actions.includes("set_text"),
			canScroll: false,
			canIncrement: false,
			canDecrement: false,
			isTextInput: roleActions.includes("set_text"),
			rect: { x: 0, y: 0, w: 0, h: 0 },
			children: childIds.map((id: string) => records.get(id)).filter(Boolean).map((child: any) => build(child, seen)).filter(Boolean),
		};
	};
	const roots = (nodes as any[]).filter((raw) => !raw?.parentId || !records.has(String(raw.parentId)));
	const children = roots.map((root) => build(root, new Set())).filter(Boolean);
	const rawOutline = children.length === 1 ? children[0] : {
		ref: `cdp:root:${snapshotId}`,
		role: "document",
		subrole: "",
		identifier: "",
		title: "Browser page",
		description: "",
		value: "",
		actions: [],
		canPress: false,
		canFocus: false,
		canSetValue: false,
		canScroll: false,
		canIncrement: false,
		canDecrement: false,
		isTextInput: false,
		rect: { x: 0, y: 0, w: 0, h: 0 },
		children,
	};
	const parsed = parseLookResponse({
		lookId: snapshotId,
		capturedAt: Date.now() / 1000,
		window: { windowId: 0, framePoints: { x: 0, y: 0, w: 1, h: 1 }, scaleFactor: 1, isModal: false, role: "document", subrole: "" },
		outline: rawOutline,
		timings: {},
	}).parsedOutline!;
	// Snapshot-local sequential IDs can silently retarget a cached ref when
	// callers pair it with a successor state. Allocate disjoint browser refs.
	if (!Number.isSafeInteger(nextBrowserElementRef + parsed.nodes.length)) throw new Error("Browser element reference space exhausted; restart the session.");
	parsed.refToWireRef.clear();
	parsed.wireRefToRef.clear();
	for (const node of parsed.nodes) {
		node.ref = `@e${nextBrowserElementRef++}`;
		if (node.wireRef) {
			parsed.refToWireRef.set(node.ref, node.wireRef);
			parsed.wireRefToRef.set(node.wireRef, node.ref);
		}
	}
	const modelRefByWire = parsed.wireRefToRef;
	for (const target of targets) target.ref = modelRefByWire.get(target.ref) ?? target.ref;
	return { targets, outline: serializeOutline(parsed) };
}

function browserActionsForAxRole(role: string): string[] {
	const normalized = role.toLowerCase();
	if (["button", "link", "checkbox", "radio", "menuitem", "tab"].includes(normalized)) return ["click"];
	if (["textbox", "searchbox", "combobox"].includes(normalized)) return ["click", "set_text"];
	if (["listbox", "slider", "spinbutton"].includes(normalized)) return ["click"];
	return [];
}

function isLocalDebuggerWebSocket(wsUrl: string, expectedPort: string | undefined): boolean {
	try {
		const parsed = new URL(wsUrl);
		const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
		return (parsed.protocol === "ws:" || parsed.protocol === "wss:") && localHosts.has(parsed.hostname) && parsed.port === expectedPort;
	} catch {
		return false;
	}
}

/**
 * Picks the tab for a window title. Disambiguation order, applied only while
 * more than one candidate remains:
 *   1. exact title matches beat prefix matches;
 *   2. the tab whose browser window frame matches the controlled window
 *      (separates same-titled tabs in different windows);
 *   3. the visible tab (separates same-titled tabs in one window — the
 *      active tab is "visible", background tabs are "hidden").
 * /json/list ordering is never trusted; it is an undocumented MRU detail.
 */
async function pickTab(pages: CdpPageTarget[], windowTitle: string, frame?: WindowFrame): Promise<CdpPageTarget | undefined> {
	const matches = pages.filter((target) => titlesMatch(target.title, windowTitle));
	if (matches.length === 0) return pages.length === 1 ? pages[0] : undefined;
	if (matches.length === 1) return matches[0];

	const wanted = windowTitle.trim().toLowerCase();
	const exact = matches.filter((target) => target.title.trim().toLowerCase() === wanted);
	const pool = exact.length > 0 ? exact : matches;
	if (pool.length === 1) return pool[0];

	let visibleFallback: CdpPageTarget | undefined;
	for (const candidate of pool) {
		try {
			const tab = await CdpTab.connect(candidate.webSocketDebuggerUrl!, candidate.id, candidate.title);
			const inFrame = await tabMatchesFrame(tab, frame, false);
			const visibility = await tab.evaluate("document.visibilityState").catch(() => undefined);
			tab.close();
			if (frame && inFrame && visibility === "visible") return candidate;
			if (frame && inFrame && !visibleFallback) visibleFallback = candidate;
			if (!frame && visibility === "visible") return candidate;
		} catch {
			// candidate unreachable; try the next one
		}
	}
	return visibleFallback ?? pool[0];
}

/**
 * Whether the tab's browser window frame matches the AX window frame.
 * `trustOnUnknown` controls the answer when bounds cannot be read: cache
 * verification trusts the existing connection, candidate selection does not.
 */
async function tabMatchesFrame(tab: CdpTab, frame: WindowFrame | undefined, trustOnUnknown = true): Promise<boolean> {
	if (!frame) return true;
	const bounds = await tab.windowBounds().catch(() => undefined);
	if (!bounds) return trustOnUnknown;
	const tolerance = 50;
	return (
		Math.abs(bounds.x + bounds.w / 2 - (frame.x + frame.w / 2)) <= tolerance &&
		Math.abs(bounds.y + bounds.h / 2 - (frame.y + frame.h / 2)) <= tolerance
	);
}

// The AX window title for a Chrome-family browser is usually the active tab
// title, sometimes suffixed (" - Google Chrome", profile name), so compare
// by prefix in both directions.
function titlesMatch(tabTitle: string, windowTitle: string): boolean {
	const tab = tabTitle.trim().toLowerCase();
	const win = windowTitle.trim().toLowerCase();
	if (!tab || !win) return false;
	return tab === win || win.startsWith(tab) || tab.startsWith(win);
}

/** Map child CSS viewport coordinates through the observed frame content quad. */
export function mapRemoteFramePoint(q: number[], width: number, height: number, x: number, y: number): {x:number;y:number} {
	if (!Array.isArray(q) || q.length !== 8 || !q.every(Number.isFinite) || ![width,height,x,y].every(Number.isFinite) || width<=0 || height<=0 || x<0 || y<0 || x>=width || y>=height) throw new Error("Remote frame geometry is invalid.");
	let orientation=0;
	for(let i=0;i<4;i++){const j=(i+1)%4,k=(i+2)%4;const cross=(q[2*j]-q[2*i])*(q[2*k+1]-q[2*j+1])-(q[2*j+1]-q[2*i+1])*(q[2*k]-q[2*j]);if(Math.abs(cross)<1e-8||orientation&&Math.sign(cross)!==orientation)throw new Error("Remote frame quad is degenerate or non-convex.");orientation=Math.sign(cross);}
	const dx1=q[2]-q[4],dx2=q[6]-q[4],dx3=q[0]-q[2]+q[4]-q[6];
	const dy1=q[3]-q[5],dy2=q[7]-q[5],dy3=q[1]-q[3]+q[5]-q[7];
	let g=0,h=0;
	if(Math.abs(dx3)>1e-8||Math.abs(dy3)>1e-8){const det=dx1*dy2-dx2*dy1;if(Math.abs(det)<1e-8)throw new Error("Remote frame projection is singular.");g=(dx3*dy2-dx2*dy3)/det;h=(dx1*dy3-dx3*dy1)/det;}
	const u=x/width,v=y/height,den=g*u+h*v+1;
	if(Math.abs(den)<1e-8)throw new Error("Remote frame projection is singular.");
	const point={x:((q[2]-q[0]+g*q[2])*u+(q[6]-q[0]+h*q[6])*v+q[0])/den,y:((q[3]-q[1]+g*q[3])*u+(q[7]-q[1]+h*q[7])*v+q[1])/den};
	if(!Number.isFinite(point.x)||!Number.isFinite(point.y))throw new Error("Remote frame projection is invalid.");return point;
}
