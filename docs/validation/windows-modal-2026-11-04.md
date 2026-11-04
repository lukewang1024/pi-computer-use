# Windows modal continuation acceptance — 2026-11-04

The candidate completed Word's **New Label → enter label → confirm → insert caption** workflow on a real Windows desktop. Common press/click paths were also exercised against application event logs. No regression attributable to this change was observed in the tested matrix below. This is a bounded acceptance run, not a guarantee for every UIA provider or application.

## Environment and method

- Windows 10 Enterprise, build 19045, x64; Word 16.0.20326.20232.
- Package 0.5.2-workbench.149, with the candidate TypeScript source and a rebuilt x64 Windows helper. Helper SHA-256: `cc3fd2e9576db49330213f1c0bf541523a58296bcbf78a77f660b4aee14e835f`.
- Final `src/bridge.ts` SHA-256: `f2e8df1ac543bd1da4080af2de3f1af680d4be649343ff6676c7f9ee575b3deb`.
- Word and WinForms tests called registered extension tools through a remote desktop session. UI mutations used `act_ui`; SSH was used for deployment, test setup, and independent read-only event/process verification.
- Browser tests used the same extension's actual `registerTool` definitions in a separate interactive process, with `managed_browser=edge`. Chrome was not installed. The fixture was served on Windows loopback; only the final audit read used `evaluate_browser`, without mutating the page.
- Comparisons used the previous candidate `453cc3b`. Both versions were run on the same machine and fixture. These targeted comparisons cover background activation and reference-based tree double-click behavior, not a complete two-version replay of the matrix.
- Test documents, processes and fixtures were isolated from the existing Word session. The machine's default desktop runtime was restored after allocating the candidate test session.

## Word results

| Scenario | Observed result |
| --- | --- |
| Press New Label | `status=modal_pending`, `dispatchCompletion=pending`; actionable observation of the newly owned dialog in about 2.7 seconds |
| Enter label in freshly observed `RichEdit Control` | `worked`; returned UI value matched the requested label |
| Confirm New Label | `target_closed`; original action reconciled as `returned`, `modalOpen=false`; no capture of the retired dialog |
| Confirm Caption | `target_closed`; document `read_text` contained `CUFinal1850 1` |
| Wait 55 seconds before typing and cancelling | Input still worked; cancelling closed the modal and reconciled the original action as returned |
| End a session with New Label still open | Helper and action worker both exited; remote session and allocation reached CLOSED without manual recovery |

The 55-second and pending-shutdown cases used the same isolated worker and timeout code before the subsequent closed-root response improvement. The final source then passed the full caption-insertion flow and ordinary session shutdown.

A logical Word edit named `标签(L):` accepted a UIA call without changing the value and correctly returned `didnt`. The freshly observed underlying `RichEdit Control` worked. No automatic retry of the original press was used.

## Common press/click P0 matrix

The native [WinForms fixture](../../scripts/fixtures/windows-press-click.cs) appends an event audit independently of tool receipts. The [browser fixture](../../scripts/fixtures/press-click-browser.html) records a page audit. Coordinate actions were grounded in fresh image-bearing states; menus and dropdowns were observed as their own windows.

| Path | Independent effect check | Result |
| --- | --- | --- |
| Semantic button `press` and left `click` | Button counter incremented once per action | PASS |
| Background semantic button press | One counter increment; old/new provider activation matched | PASS, existing activation behavior |
| Alternate button handler without opening a modal | One handler event; normal returned action | PASS |
| Checkbox on/off | Exactly `True`, then `False` | PASS |
| Radio choice B/A | Exactly `B`, then `A` | PASS |
| Tabs Advanced/General | Exactly one selection event for each tab | PASS |
| Two-action button batch (press + click) | Two consecutive increments, no extra event | PASS |
| Click edit, then enter text | Focus event and exact `p0-value` | PASS |
| Coordinate single and double click | Two left-click events total, one double-click event | PASS |
| Right click → context menu action | Context menu appeared; selected action emitted exactly one event | PASS |
| Tree coordinate double-click expand/collapse | Exactly `expanded`, then `collapsed`; child presence matched | PASS |
| Menu → action | Menu closed; exactly one handler event | PASS |
| Dropdown → Option Two | Selected value and event both `Option Two` | PASS |
| WinForms modal → enter text → confirm | One open, exact `P0 confirmed`, one returned handler | PASS |
| WinForms modal → cancel | One open, one cancel, one returned handler | PASS |
| Close root | `target_closed`; fixture process exited | PASS |
| Disabled target | Rejected before input; no disabled-button event | PASS |
| Disposed target with stale ref | Rejected before input; no removed-button event | PASS |
| Parent-root pointer attempt under separate popup | Occlusion protection rejected input; observing the popup's own root allowed selection | PASS protection |
| Browser button press + click | `count=2` | PASS |
| Browser checkbox | `check=true` | PASS |
| HTML dialog open → input → confirm | `opens=1`, `confirms=1`, exact label, `dialogOpen=false` | PASS |

The native audit contained button counts 1 through 7: five main-path invocations and two explicit old/new background comparisons. There were no duplicate dispatches or events for disabled/removed targets. Nonmodal paths did not return `modal_pending`. Ordinary physical input receipts sometimes remained `outcome=unknown`/`effectVerification=unverified`; the application event audit independently confirmed their effects. These receipts were not treated as tool failures.

### Existing behaviors and test setup corrections

- A tree-item **reference** with `clickCount:2` uses UIA SelectionItem and selects without expanding in both `453cc3b` and the candidate. It is an existing limitation, not a passing semantic-double-click guarantee. Freshly grounded coordinate double-click expanded and collapsed correctly.
- Background UIA Invoke activated the WinForms window in both versions, despite no explicit foreground escalation. This change does not promise provider-level non-activation.
- WinForms popups can be separate roots, and some expose no menu-item UIA children. Those cases used the fresh popup image for pointer grounding. A main-root attempt was rejected for occlusion, and one retired-menu attempt was rejected after test setup changed focus. Neither was blindly replayed; state was observed again before a new action.
- Initial browser harness attempts stopped before input because its selector also matched static text, then because the initial snapshot preceded page readiness. The corrected harness selected by role and used registered `wait_for`; the full run passed with exact audit assertions.
- No live macOS/Linux UI, Chrome, arbitrary nested-modal stack, secure desktop or elevated cross-integrity workflow was exercised. Existing automated platform and strict-mode checks passed.

## Automated validation

- `npm test`: PASS (full repository suite, including schema, helper transport, modal continuation, closed-root identity, input recovery, browser/CDP and other platform checks).
- Rust host tests: 187 passed, 1 ignored.
- Rebuilt x64 Windows helper and cross-compiled Windows tests.
- Windows native tests: 192 passed, 1 ignored. The foreground/WindowFromPoint test requires an interactive desktop; the initial noninteractive SSH run failed that environment requirement. The complete library suite was rerun in the interactive session and passed (143 passed, 1 ignored), in addition to the other test binaries.
- `git diff --check`: PASS.
- Cubench: **not run**. The separate checkout referenced by `docs/development.md` was unavailable, and the inferred upstream repository returned 404. The real registered-tool acceptance above is reported separately, not as a Cubench result.

## AI-assisted task transcript excerpt

This excerpt retains the implementation and validation context without publishing unrelated conversations, machine addresses, credentials or business documents.

> User: Fix pi-computer-use in the specified GitHub repository, test it, then open a PR after the tests pass.
>
> User: Continue fixing pi-computer-use. Also verify the other common press/click P0 paths for regressions.
>
> Assistant investigation: Word opens New Label, but its original synchronous UIA Invoke stays blocked until the modal closes. A subsequent operation from the same native client fails at ElementFromHandle. A separate read-only client still works. Merely returning the new modal observation does not make it operable, and the original provider call later times out.
>
> Assistant implementation: Run eligible presses once in an isolated native client contained by a kill-on-close job, with a bounded transaction lifetime. Keep the original call pending, expose only a uniquely owned fresh modal, and restrict continuation to that exact window. Do not equate unknown input with failed resource cleanup. Reconcile closed windows by PID/HWND and live absence checks.
>
> Tool evidence: New Label returned modal_pending; RichEdit setText returned worked; confirm returned target_closed with priorModalAction completion=returned and modalOpen=false; document read_text contained the inserted caption.
>
> Tool evidence: 55-second continuation and shutdown with an outstanding action passed. Native and browser audit assertions passed; existing focus activation and tree reference-double-click limitations were reproduced on the prior version.
