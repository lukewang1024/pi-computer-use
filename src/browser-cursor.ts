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
		for (const [name,value] of Object.entries({position:"fixed",left:"0",top:"0",width:"85px",height:"86px",zIndex:"2147483647",pointerEvents:"none",userSelect:"none",contain:"strict"})) {
			host.style.setProperty(name.replace(/[A-Z]/g,c=>"-"+c.toLowerCase()), value, "important");
		}
		const shadow = host.attachShadow({mode:"closed"});
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "-33 -33 85 86"); svg.setAttribute("width", "85"); svg.setAttribute("height", "86");
		svg.style.pointerEvents = "none";
		// Alpha-capable overlays include the shared blue radial halo.
		const defs = document.createElementNS(svg.namespaceURI!, "defs");
		const gradient = document.createElementNS(svg.namespaceURI!, "radialGradient");
		gradient.setAttribute("id", "pi-cursor-glow");
		const glowStops = [{"offset":0,"color":"#0088FF","opacity":0.34},{"offset":0.18,"color":"#0088FF","opacity":0.32},{"offset":0.28,"color":"#0088FF","opacity":0.23},{"offset":0.43,"color":"#0088FF","opacity":0.11},{"offset":0.5,"color":"#0088FF","opacity":0.07},{"offset":0.65,"color":"#0088FF","opacity":0.035},{"offset":0.82,"color":"#0088FF","opacity":0.016},{"offset":1,"color":"#0088FF","opacity":0}];
		for (const value of glowStops) {
			const stop = document.createElementNS(svg.namespaceURI!, "stop");
			stop.setAttribute("offset", String(value.offset));
			stop.setAttribute("stop-color", value.color);
			stop.setAttribute("stop-opacity", String(value.opacity));
			gradient.append(stop);
		}
		defs.append(gradient);
		const glow = document.createElementNS(svg.namespaceURI!, "circle");
		glow.setAttribute("cx", "8"); glow.setAttribute("cy", "8"); glow.setAttribute("r", "33");
		glow.setAttribute("fill", "url(#pi-cursor-glow)");
		svg.append(defs, glow);
		// Shared geometry and palette: src/agent-cursor-style.json.
		const layers = [{"color":"#FFFFFF","points":[[3.25,0.75],[2.25,0.5],[1.25,0.75],[0.5,1.5],[0.25,2.5],[0.5,3.5],[5,15.75],[5.5,16.75],[6.25,17.25],[7.25,17.5],[8.25,17.25],[9,16.75],[9.5,15.75],[11,11.25],[15.75,9.5],[16.75,9],[17.25,8.25],[17.5,7.25],[17.25,6.25],[16.75,5.5],[15.75,5]]},{"color":"#000000","points":[[2.5,1.75],[1.875,1.625],[1.5,2.125],[1.625,2.875],[6.125,15.625],[6.5,16.125],[7.125,16.375],[7.75,16.125],[8.125,15.5],[10,9.875],[15.625,8],[16.125,7.625],[16.375,7],[16.125,6.375],[15.5,6.125]]}];
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
		cursor.host.style.setProperty("transform", "translate("+(cursor.position.x-2-33)+"px,"+(cursor.position.y-1-33)+"px)", "important");
		if (progress < 1) cursor.frame = requestAnimationFrame(tick);
	};
	tick(started);
	cursor.timer = setTimeout(()=>{if(generation===cursor.generation)cursor.clear();}, duration+8000);
	return {delivery:"virtual", systemPointerMoved:false, inputDispatched:false};
}

export function clearBrowserCursorExpression(): string {
	return "(() => {window[Symbol.for(" + JSON.stringify(ownerKey) + ")]?.clear();return true;})()";
}
