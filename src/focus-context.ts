import type { Outline } from "./outline.ts";

export interface FocusContext {
	status: "matched" | "unobserved" | "outside_window" | "unavailable" | "ambiguous" | "budget_exceeded";
	readOnly: true;
	scopeVerified: boolean;
	wireRef?: string;
	role?: string;
	subrole?: string;
	title?: string;
	description?: string;
	isEnabled?: boolean;
	canSetValue?: boolean;
	isTextInput?: boolean;
	isSecure?: boolean;
	elapsedMs?: number;
}

export function parseFocusContext(raw: unknown): FocusContext | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const value = raw as Record<string, unknown>;
	const statuses = ["matched", "unobserved", "outside_window", "unavailable", "ambiguous", "budget_exceeded"];
	if (!statuses.includes(String(value.status))) return undefined;
	const result: FocusContext = { status: value.status as FocusContext["status"], readOnly: true, scopeVerified: value.scopeVerified === true };
	if (typeof value.elapsedMs === "number" && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) result.elapsedMs = value.elapsedMs;
	if (!result.scopeVerified || !["matched", "unobserved"].includes(result.status)) return result;
	for (const key of ["isEnabled", "canSetValue", "isTextInput", "isSecure"] as const) {
		if (typeof value[key] === "boolean") result[key] = value[key];
	}
	for (const key of ["role", "subrole", "title", "description"] as const) {
		if ((key === "title" || key === "description") && result.isSecure !== false) continue;
		if (typeof value[key] === "string") result[key] = value[key].slice(0, 256);
	}
	if (result.status === "matched" && typeof value.wireRef === "string") result.wireRef = value.wireRef;
	return result;
}

/** Only an existing ref in this exact observation can be reported. Never mint one. */
export function serializeFocusContext(context: FocusContext | undefined, outline: Outline): (Omit<FocusContext, "wireRef"> & { ref?: string }) | undefined {
	if (!context) return undefined;
	const { wireRef, ...result } = context;
	const matches = wireRef ? outline.nodes.filter(node => node.wireRef === wireRef) : [];
	if (context.status === "matched" && context.scopeVerified && matches.length === 1) return { ...result, ref: matches[0].ref };
	return { ...result, status: context.status === "matched" ? "unobserved" : context.status };
}
