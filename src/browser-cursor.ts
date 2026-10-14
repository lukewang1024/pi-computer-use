import { randomUUID } from "node:crypto";

export interface CursorPoint { x: number; y: number }
const ownerKey = "pi-computer-use.cursor." + randomUUID();

/** A closed-shadow indicator in the exact controlled page; never dispatches input. */
export function browserCursorExpression(points: CursorPoint[], durationMs = 350, click = false): string {
	if (points.length < 1 || points.length > 601 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error("Invalid virtual pointer trajectory.");
	if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 30_000) throw new Error("Invalid virtual pointer duration.");
	return "(() => {const __name = fn => fn;return (" + renderBrowserCursor.toString() + ")(" + JSON.stringify({ key: ownerKey, points, durationMs, click }) + ");})()";
}

function renderBrowserCursor(input: { key: string; points: CursorPoint[]; durationMs: number; click: boolean }) {
	const globals = window as unknown as Record<symbol, any>;
	const key = Symbol.for(input.key);
	let cursor = globals[key];
	if (!cursor || !cursor.host.isConnected) {
		cursor?.clear();
		const host = document.createElement("div");
		host.setAttribute("aria-hidden", "true"); host.setAttribute("inert", "");
		host.setAttribute("data-pi-agent-cursor", "");
		for (const [name,value] of Object.entries({position:"fixed",left:"0",top:"0",width:"34px",height:"36px",zIndex:"2147483647",pointerEvents:"none",userSelect:"none",contain:"strict"})) {
			host.style.setProperty(name.replace(/[A-Z]/g,c=>"-"+c.toLowerCase()), value, "important");
		}
		const shadow = host.attachShadow({mode:"closed"});
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 34 36"); svg.setAttribute("width", "34"); svg.setAttribute("height", "36");
		svg.style.pointerEvents = "none";
		// Shared geometry and palette: src/agent-cursor-style.json.
		const layers = [{"color":"#4C1D95","points":[[3,0],[2,0],[1,0],[1,1],[1,2],[10,32],[10,33],[10,34],[11,34],[17,20],[18,20],[18,19],[19,18],[30,11],[31,11],[30,10],[29,10]]},{"color":"#FFFFFF","points":[[4,1],[3,1],[2,1],[2,2],[2,3],[10,31],[10,32],[11,32],[17,20],[17,19],[18,18],[19,18],[29,11],[29,10],[28,10],[27,10]]},{"color":"#8B5CF6","points":[[6,4],[5,4],[4,4],[5,5],[10,26],[11,27],[16,18],[16,17],[17,17],[24,11],[23,10]]}];
		for (const layer of layers) {
			const polygon = document.createElementNS(svg.namespaceURI!, "polygon");
			polygon.setAttribute("points", layer.points.map(p=>p.join(",")).join(" "));
			polygon.setAttribute("fill", layer.color);
			svg.append(polygon);
		}
		shadow.append(svg);
		(document.fullscreenElement || document.documentElement).append(host);
		cursor = {host, position:null, frame:0, timer:0, generation:0,
			clear() {cancelAnimationFrame(this.frame); clearTimeout(this.timer); this.host.remove(); if(globals[key]===this) delete globals[key];}};
		globals[key] = cursor;
	}
	cancelAnimationFrame(cursor.frame); clearTimeout(cursor.timer);
	const points = input.points;
	if (points.length === 1) points.unshift(cursor.position || points[0]);
	const duration = input.durationMs, started = performance.now(), generation = ++cursor.generation;
	const tick = (now: number) => {
		if (generation !== cursor.generation || !cursor.host.isConnected) return;
		const progress = duration === 0 ? 1 : Math.min(1, Math.max(0, (now-started)/duration));
		const scaled = progress*(points.length-1), index = Math.min(Math.floor(scaled), points.length-2), fraction = scaled-index;
		const a = points[index], b = points[index+1];
		cursor.position = {x:a.x+(b.x-a.x)*fraction, y:a.y+(b.y-a.y)*fraction};
		cursor.host.style.setProperty("transform", "translate("+(cursor.position.x-3)+"px,"+(cursor.position.y-2)+"px)", "important");
		if (progress < 1) cursor.frame = requestAnimationFrame(tick);
	};
	tick(started);
	cursor.timer = setTimeout(()=>{if(generation===cursor.generation)cursor.clear();}, duration+8000);
	return {delivery:"virtual", systemPointerMoved:false, inputDispatched:false};
}

export function clearBrowserCursorExpression(): string {
	return "(() => {window[Symbol.for(" + JSON.stringify(ownerKey) + ")]?.clear();return true;})()";
}
