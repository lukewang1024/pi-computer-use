import assert from "node:assert/strict";
import { ensurePermissions, requestPermissions } from "../src/permissions.ts";

const requestOption = "Request missing macOS permissions";
const grantedStatus = { accessibility: true, screenRecording: true };
const missingStatus = { accessibility: false, screenRecording: false };
let status = missingStatus;
let registerCount = 0;
let openPaneCount = 0;
let restartCount = 0;
let selectCount = 0;
let notifyCount = 0;
let selectedOption = requestOption;

const bridge = {
	kinds: [
		{ kind: "accessibility", openOption: "Open Accessibility Settings (missing)" },
		{ kind: "screenRecording", openOption: "Open Screen Recording Settings (missing)" },
	],
	copy: {
		nonInteractiveError: () => "Use the explicit permission command in an interactive session.",
		prompt: () => "Choose an explicit permission action.",
		incompleteError: () => "Permissions are missing; readiness did not request them.",
		requestOption,
		recheckOption: "Recheck permissions (restart helper)",
		readyMessage: "ready",
		stillMissing: () => "still missing",
	},
	async checkPermissions() {
		return status;
	},
	async registerPermissions() {
		registerCount += 1;
		status = grantedStatus;
	},
	async openPermissionPane() {
		openPaneCount += 1;
	},
	async restartHelper() {
		restartCount += 1;
	},
};

function context({ hasUI = true } = {}) {
	return {
		hasUI,
		ui: {
			async select(_prompt, options) {
				selectCount += 1;
				assert(options.includes(selectedOption), "explicit option should be presented");
				return selectedOption;
			},
			notify() {
				notifyCount += 1;
			},
		},
	};
}

for (let session = 0; session < 3; session += 1) {
	status = missingStatus;
	await assert.rejects(
		ensurePermissions(context(), bridge, "/test/pi-computer-use.app"),
		/Permissions are missing; readiness did not request them\./,
		`missing permissions in session ${session + 1} should return an actionable error`,
	);
}
	assert.equal(registerCount, 0, "ordinary readiness across sessions must never register permissions");
	assert.equal(openPaneCount, 0, "ordinary readiness must never open System Settings");
	assert.equal(restartCount, 0, "ordinary readiness must never restart the helper");
assert.equal(selectCount, 0, "ordinary readiness must not show a permission selection prompt");

await assert.rejects(
	ensurePermissions(context({ hasUI: false }), bridge, "/test/pi-computer-use.app"),
	/explicit permission command/,
);
assert.equal(registerCount, 0, "headless readiness must not request permissions");

status = missingStatus;
selectedOption = requestOption;
const afterExplicitRequest = await requestPermissions(context(), bridge, "/test/pi-computer-use.app");
assert.deepEqual(afterExplicitRequest, grantedStatus);
assert.equal(registerCount, 1, "the explicit request choice should issue exactly one request");
assert.equal(selectCount, 1, "the explicit permission command should show one action choice");
assert.equal(notifyCount, 1, "successful explicit request should notify readiness");

status = missingStatus;
selectedOption = "Open Accessibility Settings (missing)";
await requestPermissions(context(), bridge, "/test/pi-computer-use.app");
assert.equal(registerCount, 1, "opening Settings must not invoke permission request APIs");
assert.equal(openPaneCount, 1, "an explicit Settings action opens only the selected pane");

status = missingStatus;
selectedOption = "Cancel";
await requestPermissions(context(), bridge, "/test/pi-computer-use.app");
assert.equal(registerCount, 1, "cancel must not invoke permission request APIs");
assert.equal(openPaneCount, 1, "cancel must not open System Settings");

status = missingStatus;
selectedOption = "Recheck permissions (restart helper)";
await requestPermissions(context(), bridge, "/test/pi-computer-use.app");
assert.equal(registerCount, 1, "recheck must not invoke permission request APIs");
assert.equal(restartCount, 1, "only an explicit recheck action restarts the helper");

console.log("[check-permission-readiness] passive readiness and explicit permission actions passed");
