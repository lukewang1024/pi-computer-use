# Browser viewport paint readiness

An observed DOM, a completed load event and retained paint entries do not prove that the compositor surface is current. Viewport capture waits for two animation-frame callbacks in the exact connected CDP page before reading layout and requesting its screenshot.

The visible-page wait is bounded to 1,200 milliseconds. An elapsed deadline or changed document produces a capture failure with a bounded reason. Initially hidden pages retain the existing CDP capture path because their animation callbacks may be suspended; no visible-frame synchronization is established for them. The helper does not navigate again, activate a window or replay input. It cancels its own remaining timer and animation callbacks.

This readiness condition reduces a reproduced capture timing race. It does not establish that a screenshot contains the intended text, image or application result: inspect the returned image. Legitimately blank pages remain possible. Existing pixel-only document identity checks and viewport scale checks still apply.

The change applies to CDP browser-page capture. It does not establish a common cause for native Windows document-window capture failures.
