/** Fixed, bounded measurements; never exposes arbitrary evaluation to callers. */
export const BROWSER_PERFORMANCE_SAMPLE = String.raw`(async () => {
 const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
 const identityStart = {href:location.href,timeOrigin:performance.timeOrigin};
 const started = performance.now();
 while(document.readyState !== 'complete' && performance.now() - started < 3000)
   await new Promise(resolve => setTimeout(resolve, 100));
 const loadWait = {complete: document.readyState === 'complete', elapsedMs: performance.now()-started, budgetMs:3000};
 const entries={}, supported=[], observers=[], failures={};
 let truncated=false;
 const kinds=['paint','largest-contentful-paint','layout-shift','event','longtask'];
 const available=typeof PerformanceObserver === 'function' && Array.isArray(PerformanceObserver.supportedEntryTypes)
   ? PerformanceObserver.supportedEntryTypes : [];
 const add=(type, rows)=>{
   for(const e of rows){
     if(entries[type].length>=64){truncated=true;break;}
     entries[type].push({name: typeof e.name==='string'?e.name.slice(0,128):'',
       startTime:finite(e.startTime),duration:finite(e.duration),value:finite(e.value),
       hadRecentInput:e.hadRecentInput,interactionId:finite(e.interactionId)});
   }
 };
 for(const type of kinds){
   if(!available.includes(type))continue;
   let observer;
   try{
     entries[type]=[];
     observer=new PerformanceObserver(list=>{try{add(type,list.getEntries());}catch{
       failures[type]='observer callback failed';delete entries[type];
     }});
     observer.observe({type,buffered:true,...(type==='event'?{durationThreshold:16}:{})});
     observers.push({type,observer});supported.push(type);
   }catch{
     failures[type]='observer installation failed';delete entries[type];
     try{observer?.disconnect();}catch{}
   }
 }
 try{
   await new Promise(resolve=>setTimeout(resolve,100));
   for(const {type,observer} of observers){
     if(!entries[type])continue;
     try{add(type,observer.takeRecords());}catch{failures[type]='observer flush failed';delete entries[type];}
   }
 }finally{
   for(const {observer} of observers){try{observer.disconnect();}catch{}}
 }
 const observation={entries,supported:supported.filter(type=>entries[type]),failures,truncated,
   visibility:document.visibilityState,collectedAtMs:finite(performance.now()),
   collectorInstalledAfterNavigation:true,scope:'top-frame retained buffer; incomplete page lifetime'};
 const n=performance.getEntriesByType('navigation')[0];
 const navigation={url:(location.origin+location.pathname).slice(0,2048),readyState:document.readyState,timeOriginMs:finite(performance.timeOrigin),
   navigation:n?{type:typeof n.type==='string'?n.type.slice(0,32):'',durationMs:finite(n.duration),
     dnsMs:finite(n.domainLookupEnd-n.domainLookupStart),connectMs:finite(n.connectEnd-n.connectStart),
     requestToFirstByteMs:finite(n.responseStart-n.requestStart),domContentLoadedMs:finite(n.domContentLoadedEventEnd),
     loadEndMs:finite(n.loadEventEnd),transferBytes:finite(n.transferSize)}:null,
   paints:performance.getEntriesByType('paint').slice(0,64).map(p=>({name:typeof p.name==='string'?p.name.slice(0,128):'',startMs:finite(p.startTime)})),
   resourceCount:performance.getEntriesByType('resource').length};
 const heading = document.querySelector?.('h1')?.textContent;
 const documentIdentity={consistent:identityStart.href===location.href && identityStart.timeOrigin===performance.timeOrigin,
   url:navigation.url,timeOriginMs:finite(performance.timeOrigin),
   title:typeof document.title==='string'?document.title.slice(0,512):null,
   heading:typeof heading==='string'?heading.trim().slice(0,512):null};
 return {navigation,observation,loadWait,documentIdentity};
})()`;

export interface BrowserMetricsRead {
	readOnly: true;
	performanceSample?: Record<string, unknown>;
	performanceError?: { status: "unavailable"; message: string; completion: "unconfirmed" };
}

/** Fixed read only: a failed sample never triggers navigation, input or refresh. */
export async function readBrowserMetrics(contextId: string,
	evaluate: (contextId: string, expression: string) => Promise<{ value: unknown } | undefined>): Promise<BrowserMetricsRead> {
	try {
		const result = await evaluate(contextId, BROWSER_PERFORMANCE_SAMPLE);
		if (!result?.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error("Structured performance sample unavailable.");
		const sample = result.value as Record<string, unknown>;
		const identity = sample.documentIdentity;
		if (!identity || typeof identity !== "object" || (identity as Record<string, unknown>).consistent !== true) throw new Error("Document identity changed or could not be established during collection.");
		return { readOnly: true, performanceSample: sample };
	} catch (error) {
		return { readOnly: true, performanceError: { status: "unavailable", completion: "unconfirmed",
			message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) } };
	}
}

export interface NavigationPerformanceResult<T> {
	observation: T;
	performanceSample?: Record<string, unknown>;
	performanceError?: { status: "unavailable"; readOnly: true; phase: "after-navigation"; message: string };
}

/** Navigation and successor refresh remain mandatory and are submitted once. */
export async function navigateWithPerformance<T>(contextId: string, url: string, includePerformance: boolean | undefined,
	deps: {
		navigate: (contextId: string, url: string) => Promise<boolean>;
		evaluate: (contextId: string, expression: string) => Promise<{ value: unknown } | undefined>;
		refresh: () => Promise<T>;
	}): Promise<NavigationPerformanceResult<T>> {
	if (includePerformance !== undefined && typeof includePerformance !== "boolean") throw new Error("navigate_browser.includePerformance must be boolean.");
	if (!await deps.navigate(contextId, url)) throw new Error(`Browser context '${contextId}' is no longer available. Observe it again.`);
	let performanceSample: Record<string, unknown> | undefined;
	let performanceError: NavigationPerformanceResult<T>["performanceError"];
	if (includePerformance) {
		try {
			const result = await deps.evaluate(contextId, BROWSER_PERFORMANCE_SAMPLE);
			if (!result || !result.value || typeof result.value !== "object" || Array.isArray(result.value)) throw new Error("Structured performance sample unavailable.");
			performanceSample = result.value as Record<string, unknown>;
		} catch (error) {
			performanceError = { status: "unavailable", readOnly: true, phase: "after-navigation",
				message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) };
		}
	}
	// A metrics failure cannot erase successful navigation or authorize a replay.
	return { observation: await deps.refresh(), performanceSample, performanceError };
}


/** Compact model-facing summary; full bounded entries remain in structured details. */
export function summarizeBrowserPerformance(sample: Record<string, unknown>): Record<string, unknown> {
	const raw = sample.observation;
	const observation = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	const rawEntries = observation.entries;
	const entries = rawEntries && typeof rawEntries === "object" && !Array.isArray(rawEntries) ? rawEntries as Record<string, unknown> : {};
	const entryCounts = Object.fromEntries(["paint", "largest-contentful-paint", "layout-shift", "event", "longtask"]
		.filter(kind => Array.isArray(entries[kind])).map(kind => [kind, (entries[kind] as unknown[]).length]));
	return { navigation: sample.navigation, loadWait: sample.loadWait,
		observation: { supported: observation.supported, truncated: observation.truncated,
			scope: observation.scope, failures: observation.failures, entryCounts },
		pageHealth: "not-assessed", finalCoreWebVitals: false };
}
