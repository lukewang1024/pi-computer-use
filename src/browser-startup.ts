import type { ChildProcess } from "node:child_process";

/** Observe startup only; never restart or replay a browser launch. */
export async function waitForBrowserStartup(
 child: ChildProcess,
 ready: (signal: AbortSignal) => Promise<void>,
 signal?: AbortSignal,
): Promise<void> {
 const controller = new AbortController();
 const abort = () => controller.abort(signal?.reason);
 signal?.addEventListener("abort", abort, { once: true });
 if (signal?.aborted) abort();
 let onError: (error: Error) => void;
 let onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
 const failed = new Promise<never>((_, reject) => {
  onError = (error) => reject(new Error(`Managed browser failed to start: ${error.message}`, { cause: error }));
  onExit = (code, signal) => reject(new Error(`Managed browser exited before CDP was ready (code=${code}, signal=${signal}).`));
  child.once("error", onError);
  child.once("exit", onExit);
 });
 try {
  await Promise.race([failed, ready(controller.signal)]);
 } finally {
  controller.abort();
  signal?.removeEventListener("abort", abort);
  // A canceled launch can still emit an asynchronous spawn error. Keep its
  // once-listener until that error arrives when no child PID was created.
  if (child.pid !== undefined) child.removeListener("error", onError!);
  child.removeListener("exit", onExit!);
 }
}
