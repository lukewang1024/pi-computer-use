//! Read-only UIA (UI Automation) element extraction for Windows.
//!
//! On Windows, uses the [`windows`] crate to walk the UIA accessibility tree
//! of a given top-level window and extract semantic elements with their
//! properties.  On non-Windows platforms all entry points are stubbed out
//! and return empty results.
//!
//! UIA element extraction for model-visible outlines and element metadata.

use serde_json::Value;

use crate::refs::RefStore;

#[cfg(any(windows, test))]
struct ElementIdentityResolver<T> {
    runtime_id: Vec<i32>,
    automation_id: String,
    candidate: Option<T>,
    ambiguous: bool,
}

#[cfg(any(windows, test))]
impl<T> ElementIdentityResolver<T> {
    fn new(runtime_id: &[i32], automation_id: &str) -> Result<Self, String> {
        if runtime_id.is_empty() && automation_id.is_empty() {
            return Err("Element reference has no identity".to_owned());
        }
        Ok(Self { runtime_id: runtime_id.to_vec(), automation_id: automation_id.to_owned(),
                  candidate: None, ambiguous: false })
    }

    fn matches(&self, runtime_id: Option<&[i32]>, automation_id: &str) -> bool {
        if !self.runtime_id.is_empty() {
            runtime_id == Some(self.runtime_id.as_slice())
        } else {
            automation_id == self.automation_id
        }
    }

    fn observe(&mut self, runtime_id: Option<&[i32]>, automation_id: &str, element: T) {
        if self.matches(runtime_id, automation_id) {
            if self.candidate.is_some() { self.ambiguous = true; }
            self.candidate = Some(element);
        }
    }

    fn finish(self) -> Result<T, String> {
        if self.ambiguous { return Err("Element reference is ambiguous".to_owned()); }
        self.candidate.ok_or_else(|| "Element reference is stale".to_owned())
    }
}

// Preserve the extraction root and a few late document anchors without raising
// the property-cache/output budget. Each index is visited at most once.
#[cfg(any(windows, test))]
fn extraction_order(count: usize, limit: usize, anchors: &[usize]) -> Vec<usize> {
    let mut result = Vec::with_capacity(count.min(limit));
    if count == 0 || limit == 0 { return result; }
    result.push(0);
    for &index in anchors.iter().take(8) {
        if result.len() == limit { break; }
        if index < count && !result.contains(&index) { result.push(index); }
    }
    for index in 1..count.min(limit) {
        if result.len() == limit { break; }
        if !result.contains(&index) { result.push(index); }
    }
    result
}

#[cfg(any(windows, test))]
fn extraction_diagnostics(total_found: usize, raw_visited: usize, visible_retained: usize) -> Value {
    serde_json::json!({
        "totalFound": total_found,
        "rawVisited": raw_visited,
        "visibleRetained": visible_retained,
        "rawTruncated": total_found > raw_visited
    })
}


#[cfg(any(windows, test))]
fn failed_extraction(error: &str) -> Vec<Value> {
    vec![serde_json::json!({
        "diagnosticOnly": true,
        "extractionDiagnostics": {
            "status": "incomplete",
            "reason": if error.starts_with("UIA read worker deadline exceeded;") { "read_timeout" } else { "provider_error" },
            "error": error,
            "rawTruncated": true, "rawVisited": 0, "visibleRetained": 0
        }
    })]
}


#[cfg(any(windows, test))]
fn retained_ancestor<T>(
    mut current: T,
    retained: &std::collections::HashSet<String>,
    cache: &mut std::collections::HashMap<String, String>,
    mut identity: impl FnMut(&T) -> Option<String>,
    mut parent: impl FnMut(&T) -> Option<T>,
) -> Option<String> {
    // Extraction-local only: never reuse ancestry across observations.
    let mut path = Vec::new();
    let mut key = identity(&current).filter(|key| !key.is_empty())?;
    for _ in 0..64 {
        if let Some(ancestor) = cache.get(&key).cloned() {
            for visited in path { cache.insert(visited, ancestor.clone()); }
            return Some(ancestor);
        }
        path.push(key);
        current = parent(&current)?;
        key = identity(&current).filter(|key| !key.is_empty())?;
        if retained.contains(&key) {
            for visited in path { cache.insert(visited, key.clone()); }
            return Some(key);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/// Extract UIA accessible elements from the window identified by `hwnd`.
///
/// Returns a `Vec` of JSON objects, each with shape:
/// ```json
/// {
///   "ref": "@e1",
///   "role": "edit",
///   "label": "Address bar",
///   "automationId": "1001",
///   "className": "Edit",
///   "bounds": { "x": 0, "y": 0, "width": 100, "height": 20 },
///   "capabilities": { "isEnabled": true, "isOffscreen": false }
/// }
/// ```
///
/// On non-Windows this always returns an empty `Vec`.
pub fn extract_elements(store: &mut RefStore, hwnd: isize) -> Vec<Value> {
    #[cfg(not(windows))]
    {
        let _ = store;
        let _ = hwnd;
        Vec::new()
    }

    #[cfg(windows)]
    {
        match bounded_extract(store, hwnd, &[], "") {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[uia] WARN extraction skipped: {e}");
                failed_extraction(&e)
            }
        }
    }
}

/// Extract the subtree rooted at a previously observed element.
pub fn extract_elements_from(
    store: &mut RefStore,
    hwnd: isize,
    runtime_id: &[i32],
    automation_id: &str,
) -> Result<Vec<Value>, String> {
    #[cfg(not(windows))]
    {
        let _ = (store, hwnd, runtime_id, automation_id);
        Ok(Vec::new())
    }
    #[cfg(windows)]
    {
        bounded_extract(store, hwnd, runtime_id, automation_id)
    }
}

// UIA's provider transaction timeout does not bound every provider hook. Keep
// discovery in a disposable, read-only process; never move action dispatch here.
#[cfg(windows)]
fn bounded_extract(store: &mut RefStore, hwnd: isize, runtime_id: &[i32], automation_id: &str)
    -> Result<Vec<Value>, String> {
    use std::{os::windows::process::CommandExt, process::Command, time::Duration};
    let request = serde_json::json!({"hwnd": hwnd, "runtimeId": runtime_id, "automationId": automation_id}).to_string();
    if request.len() > 8_000 { return Err("UIA read worker request limit exceeded".into()); }
    let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
    command.args(["--read-only-uia", &request]).creation_flags(0x08000000);
    let output = crate::read_worker::run(&mut command, Duration::from_millis(8_500), 8 * 1024 * 1024)?;
    let response: Value = serde_json::from_slice(&output).map_err(|e| e.to_string())?;
    if let Some(error) = response.get("error").and_then(Value::as_str) { return Err(error.into()); }
    let elements: Vec<Value> = serde_json::from_value(response.get("elements").cloned()
        .ok_or("UIA read worker missing elements")?).map_err(|e| e.to_string())?;
    Ok(adopt_worker_elements(store, elements))
}

#[cfg(any(windows, test))]
fn adopt_worker_elements(store: &mut RefStore, mut elements: Vec<Value>) -> Vec<Value> {
    // Worker-local references must never collide with existing parent looks.
    // Only JSON/runtime identities cross the process boundary, never COM pointers.
    for element in &mut elements {
        if element.get("diagnosticOnly").and_then(Value::as_bool) != Some(true) {
            element["ref"] = Value::String(store.insert_element(crate::refs::NativeHandle::new(0)).to_string());
        }
    }
    elements
}

/// Dedicated worker mode: read-only extraction only, no protocol/action loop.
#[cfg(windows)]
pub fn read_only_worker(request: &str) -> Value {
    let result = (|| -> Result<Vec<Value>, String> {
        if request.len() > 8_000 { return Err("UIA read worker request limit exceeded".into()); }
        let request: Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
        let hwnd = request.get("hwnd").and_then(Value::as_i64).ok_or("Missing HWND")? as isize;
        let runtime_id: Vec<i32> = serde_json::from_value(request.get("runtimeId").cloned()
            .ok_or("Missing runtime ID")?).map_err(|e| e.to_string())?;
        let automation_id = request.get("automationId").and_then(Value::as_str).ok_or("Missing automation ID")?;
        let mut store = RefStore::new();
        if runtime_id.is_empty() && automation_id.is_empty() { native::uia_extract(&mut store, hwnd) }
        else { native::uia_extract_from(&mut store, hwnd, &runtime_id, automation_id) }
    })();
    match result {
        Ok(elements) => serde_json::json!({"elements": elements}),
        Err(error) => serde_json::json!({"error": error}),
    }
}

// ---------------------------------------------------------------------------
// UIA control type → semantic role mapping
//
// These constants and the mapping function are always compiled because
// they are exercised by cross-platform unit tests, but on non-Windows the
// compiler flags them as dead code since they are only called from the
// `#[cfg(windows)] native` module.  We suppress the lint for that case.
// ---------------------------------------------------------------------------

#[cfg_attr(not(windows), allow(dead_code))]
const UIA_WINDOW_CONTROL: u32 = 50032;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_PANE_CONTROL: u32 = 50033;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_DOCUMENT_CONTROL: u32 = 50030;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_EDIT_CONTROL: u32 = 50004;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_BUTTON_CONTROL: u32 = 50000;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SPLITBUTTON_CONTROL: u32 = 50031;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_CHECKBOX_CONTROL: u32 = 50002;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_RADIOBUTTON_CONTROL: u32 = 50013;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_COMBOBOX_CONTROL: u32 = 50003;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_LIST_CONTROL: u32 = 50008;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_LISTITEM_CONTROL: u32 = 50007;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TREE_CONTROL: u32 = 50023;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TREEITEM_CONTROL: u32 = 50024;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_MENUITEM_CONTROL: u32 = 50011;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TEXT_CONTROL: u32 = 50020;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HYPERLINK_CONTROL: u32 = 50005;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TAB_CONTROL: u32 = 50018;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TABITEM_CONTROL: u32 = 50019;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HEADER_CONTROL: u32 = 50034;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_HEADERITEM_CONTROL: u32 = 50035;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TABLE_CONTROL: u32 = 50036;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_IMAGE_CONTROL: u32 = 50006;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SLIDER_CONTROL: u32 = 50015;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_PROGRESSBAR_CONTROL: u32 = 50012;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TOOLBAR_CONTROL: u32 = 50021;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_STATUSBAR_CONTROL: u32 = 50017;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_TOOLTIP_CONTROL: u32 = 50022;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SCROLLBAR_CONTROL: u32 = 50014;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_GROUP_CONTROL: u32 = 50026;
#[cfg_attr(not(windows), allow(dead_code))]
const UIA_SEPARATOR_CONTROL: u32 = 50038;

/// Map a UIA control type ID to a semantic role string.
///
/// Returns `"unknown"` for unrecognised control type IDs.
#[cfg_attr(not(windows), allow(dead_code))]
fn control_type_to_role(ctrl_type: u32) -> &'static str {
    match ctrl_type {
        UIA_WINDOW_CONTROL => "window",
        UIA_PANE_CONTROL => "pane",
        UIA_DOCUMENT_CONTROL => "document",
        UIA_EDIT_CONTROL => "edit",
        UIA_BUTTON_CONTROL | UIA_SPLITBUTTON_CONTROL => "button",
        UIA_CHECKBOX_CONTROL => "checkbox",
        UIA_RADIOBUTTON_CONTROL => "radio",
        UIA_COMBOBOX_CONTROL => "comboBox",
        UIA_LIST_CONTROL => "list",
        UIA_LISTITEM_CONTROL => "listItem",
        UIA_TREE_CONTROL => "tree",
        UIA_TREEITEM_CONTROL => "treeItem",
        UIA_MENUITEM_CONTROL => "menuItem",
        UIA_TEXT_CONTROL => "text",
        UIA_HYPERLINK_CONTROL => "link",
        UIA_TAB_CONTROL => "tab",
        UIA_TABITEM_CONTROL => "tabItem",
        UIA_HEADER_CONTROL => "header",
        UIA_HEADERITEM_CONTROL => "headerItem",
        UIA_TABLE_CONTROL => "table",
        UIA_IMAGE_CONTROL => "image",
        UIA_SLIDER_CONTROL => "slider",
        UIA_PROGRESSBAR_CONTROL => "progressBar",
        UIA_TOOLBAR_CONTROL => "toolBar",
        UIA_STATUSBAR_CONTROL => "statusBar",
        UIA_TOOLTIP_CONTROL => "toolTip",
        UIA_SCROLLBAR_CONTROL => "scrollBar",
        UIA_GROUP_CONTROL => "group",
        UIA_SEPARATOR_CONTROL => "separator",
        _ => "unknown",
    }
}

#[derive(Clone, Debug, Default)]
pub struct ElementAnnotationSignals {
    pub invoke: bool,
    pub toggle: bool,
    pub selection_item: bool,
    pub expand_collapse: bool,
    pub legacy_default_action: bool,
    pub value: bool,
    pub text: bool,
    pub value_read_only: Option<bool>,
}

pub fn annotation_can_press(signals: &ElementAnnotationSignals) -> bool {
    signals.invoke
        || signals.toggle
        || signals.selection_item
        || signals.expand_collapse
        || signals.legacy_default_action
}

pub fn annotation_can_set_text(signals: &ElementAnnotationSignals) -> bool {
    signals.value && !signals.value_read_only.unwrap_or(false) || signals.text
}

// ---------------------------------------------------------------------------
// Windows implementation  (windows crate)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod native {
    use serde_json::{json, Value};
    use std::collections::{HashMap, HashSet};
    use std::time::Instant;

    use super::{
        annotation_can_press, annotation_can_set_text, control_type_to_role,
        ElementAnnotationSignals, ElementIdentityResolver,
    };
    use crate::refs::{NativeHandle, RefStore};

    use windows::core::{BSTR, VARIANT, Interface};
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Com::*;
    use windows::Win32::System::Ole::{
        SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound,
    };
    use windows::Win32::UI::Accessibility::*;

    const MAX_ELEMENTS: usize = 200;
    const EXTRACTION_BUDGET_MS: u64 = 8_000;
    const MAX_TRUNCATION_SCAN: usize = 1_000;

    fn read_only_client() -> Result<IUIAutomation, String> {
        // Read-only extraction uses the modern provider client with finite per-call
        // timeouts. Do not silently fall back to an unbounded older client.
        let modern: IUIAutomation2 = unsafe {
            CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance IUIAutomation2: {e}"))?
        };
        unsafe {
            modern.SetConnectionTimeout(2_000)
                .map_err(|e| format!("SetConnectionTimeout: {e}"))?;
            modern.SetTransactionTimeout(3_000)
                .map_err(|e| format!("SetTransactionTimeout: {e}"))?;
        }
        modern.cast()
            .map_err(|e| format!("IUIAutomation2 base interface: {e}"))

    }

    /// Entry point called from the public stub on cfg(windows).
    pub fn uia_extract(store: &mut RefStore, hwnd: isize) -> Result<Vec<Value>, String> {
        let _com = ComGuard::new()?;

        let uia = read_only_client()?;

        let root = unsafe {
            uia.ElementFromHandle(HWND(hwnd as *mut _))
                .map_err(|e| format!("ElementFromHandle: {e}"))?
        };

        extract_from_root(store, &uia, &root)
    }

    pub fn uia_extract_from(
        store: &mut RefStore,
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<Vec<Value>, String> {
        let (_com, uia, root) = resolve_for_read(hwnd, runtime_id_target, automation_id)?;
        extract_from_root(store, &uia, &root)
    }

    fn extract_from_root(
        store: &mut RefStore,
        uia: &IUIAutomation,
        root: &IUIAutomationElement,
    ) -> Result<Vec<Value>, String> {
        // Cooperative whole-extraction budget: never begin another provider
        // traversal after expiry. An in-flight COM call still has its own timeout.
        let extraction_started = Instant::now();
        let budget_expired = || extraction_started.elapsed().as_millis() >= EXTRACTION_BUDGET_MS as u128;
        let condition = unsafe {
            uia.CreateTrueCondition()
                .map_err(|e| format!("CreateTrueCondition: {e}"))?
        };

        let find_started = Instant::now();
        let found = unsafe {
            root.FindAll(TreeScope_Subtree, &condition)
                .map_err(|e| format!("FindAll: {e}"))?
        };

        let find_ms = find_started.elapsed().as_millis() as u64;

        // Cache only each retained element, not the whole unbounded subtree.
        // Full element mode keeps live pattern/action resolution available.
        let property_cache = unsafe {
            uia.CreateCacheRequest().ok().and_then(|cache| {
                cache.SetTreeScope(TreeScope_Element).ok()?;
                cache.SetTreeFilter(&condition).ok()?;
                for property in [UIA_ControlTypePropertyId, UIA_NamePropertyId,
                    UIA_AutomationIdPropertyId, UIA_ClassNamePropertyId,
                    UIA_BoundingRectanglePropertyId, UIA_IsOffscreenPropertyId,
                    UIA_IsEnabledPropertyId, UIA_IsKeyboardFocusablePropertyId,
                    UIA_IsPasswordPropertyId, UIA_IsInvokePatternAvailablePropertyId,
                    UIA_IsTogglePatternAvailablePropertyId, UIA_IsSelectionItemPatternAvailablePropertyId,
                    UIA_IsExpandCollapsePatternAvailablePropertyId, UIA_IsLegacyIAccessiblePatternAvailablePropertyId,
                    UIA_IsValuePatternAvailablePropertyId, UIA_IsTextPatternAvailablePropertyId,
                    UIA_IsScrollPatternAvailablePropertyId] {
                    cache.AddProperty(property).ok()?;
                }
                Some(cache)
            })
        };

        let count = unsafe {
            found
                .Length()
                .map_err(|e| format!("ElementArray.Length: {e}"))?
        } as usize;

        let limit = count.min(MAX_ELEMENTS);
        // The provider's depth-first order can put the actual document after
        // hundreds of ribbon/sidebar nodes. Inspect only a short omitted tail
        // for document anchors, then reserve slots inside the existing limit.
        // No names/classes/PIDs are treated as input authority.
        let anchor_started = Instant::now();
        let mut anchor_scanned = 0usize;
        let mut anchors = Vec::new();
        for index in limit..count.min(limit + 64) {
            if budget_expired() || anchor_started.elapsed().as_millis() >= 500 || anchors.len() >= 8 { break; }
            let Some(element) = (unsafe { found.GetElement(index as _).ok() }) else { continue };
            anchor_scanned += 1;
            if unsafe { element.CurrentControlType().ok() } == Some(UIA_DocumentControlTypeId) {
                anchors.push(index);
            }
        }
        let anchor_ms = anchor_started.elapsed().as_millis() as u64;
        let order = super::extraction_order(count, MAX_ELEMENTS, &anchors);
        let selected = order.iter().copied().collect::<HashSet<_>>();
        let mut elements = Vec::with_capacity(limit);
        let walker = unsafe {
            uia.ControlViewWalker()
                .map_err(|e| format!("ControlViewWalker: {e}"))?
        };

        let retained_started = Instant::now();
        let mut visited = 0usize;
        let mut cache_failures = 0usize;
        for i in order {
            if budget_expired() { break; }
            let element = unsafe {
                found
                    .GetElement(i as _)
                    .map_err(|e| format!("GetElement({i}): {e}"))?
            };
            visited += 1;
            let parent_runtime_id = unsafe { walker.GetParentElement(&element).ok() }
                .and_then(|parent| runtime_id(&parent))
                .unwrap_or_default();
            if budget_expired() { break; }
            // A failed cache must not fan out into many live property requests.
            // Keep already observed nodes and explicitly report the missing ones.
            let Some(observed) = property_cache.as_ref()
                .and_then(|cache| unsafe { element.BuildUpdatedCache(cache).ok() }) else {
                    cache_failures += 1;
                    continue;
                };
            if let Some(json_val) = element_to_json(store, &observed, parent_runtime_id) {
                elements.push(json_val);
            }
        }

        let retained_ms = retained_started.elapsed().as_millis() as u64;
        let truncation_started = Instant::now();
        let mut ancestry_reads = 0usize;
        let mut ancestry_candidates = 0usize;
        let mut ancestry_entries = 0usize;
        if count > limit {
            let retained = elements
                .iter()
                .filter_map(|element| element.get("runtimeId").and_then(Value::as_array))
                .map(|runtime_id| {
                    runtime_id
                        .iter()
                        .filter_map(Value::as_i64)
                        .map(|value| value.to_string())
                        .collect::<Vec<_>>()
                        .join(".")
                })
                .collect::<HashSet<_>>();
            let mut truncated = HashSet::new();
            let mut ancestry_cache = HashMap::new();
            let mut omitted_scanned = 0usize;
            for i in 0..count {
                if selected.contains(&i) { continue; }
                if budget_expired() || omitted_scanned >= MAX_TRUNCATION_SCAN { break; }
                omitted_scanned += 1;
                let Some(candidate) = (unsafe { found.GetElement(i as _).ok() }) else { continue };
                ancestry_candidates += 1;
                if let Some(key) = super::retained_ancestor(
                    candidate, &retained, &mut ancestry_cache,
                    |element| if budget_expired() { None } else { runtime_id(element).map(|ids| ids.iter()
                        .map(i32::to_string).collect::<Vec<_>>().join(".")) },
                    |element| {
                        if budget_expired() { return None; }
                        ancestry_reads += 1;
                        unsafe { walker.GetParentElement(element).ok() }
                    },
                ) {
                    truncated.insert(key);
                }
            }
            ancestry_entries = ancestry_cache.len();
            // If the omitted tail is larger than the bounded ancestry scan,
            // mark the retained extraction root as an honest coarse boundary.
            if count > limit + MAX_TRUNCATION_SCAN {
                let root_key = runtime_id(root)
                    .unwrap_or_default()
                    .iter()
                    .map(i32::to_string)
                    .collect::<Vec<_>>()
                    .join(".");
                truncated.insert(root_key);
            }
            for element in &mut elements {
                let key = element
                    .get("runtimeId")
                    .and_then(Value::as_array)
                    .map(|runtime_id| {
                        runtime_id
                            .iter()
                            .filter_map(Value::as_i64)
                            .map(|value| value.to_string())
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                if truncated.contains(&key) {
                    element["truncated"] = json!(true);
                }
            }
        }

        let mut diagnostics = super::extraction_diagnostics(count, visited, elements.len());
        diagnostics["budgetMs"] = json!(EXTRACTION_BUDGET_MS);
        diagnostics["elapsedMs"] = json!(extraction_started.elapsed().as_millis() as u64);
        diagnostics["cacheFailures"] = json!(cache_failures);
        diagnostics["documentAnchors"] = json!({
            "tailCandidatesScanned": anchor_scanned, "selected": anchors.len(),
            "scanMs": anchor_ms,
            "candidateLimit": 64, "cooperativeBudgetMs": 500
        });
        if budget_expired() || cache_failures > 0 {
            diagnostics["status"] = json!("incomplete");
            diagnostics["reason"] = json!(if budget_expired() { "budget_exceeded" } else { "cache_unavailable" });
            diagnostics["rawTruncated"] = json!(true);
        }
        diagnostics["stages"] = json!({
            "findAllMs": find_ms, "retainedElementsMs": retained_ms,
            "truncationMs": truncation_started.elapsed().as_millis() as u64
        });
        diagnostics["truncationAncestry"] = json!({
            "parentReads": ancestry_reads, "omittedCandidatesScanned": ancestry_candidates,
            "cacheEntries": ancestry_entries
        });
        if let Some(first) = elements.first_mut() {
            first["extractionDiagnostics"] = diagnostics;
        } else if diagnostics["status"] == "incomplete" {
            elements.push(json!({ "diagnosticOnly": true, "extractionDiagnostics": diagnostics }));
        }
        Ok(elements)
    }

    fn runtime_id(element: &IUIAutomationElement) -> Option<Vec<i32>> {
        let array = unsafe { element.GetRuntimeId().ok()? };
        if array.is_null() {
            return None;
        }
        let lower = unsafe { SafeArrayGetLBound(array, 1).ok()? };
        let upper = unsafe { SafeArrayGetUBound(array, 1).ok()? };
        let mut values = Vec::with_capacity((upper - lower + 1).max(0) as usize);
        for index in lower..=upper {
            let mut value = 0i32;
            unsafe {
                SafeArrayGetElement(
                    array,
                    &index,
                    &mut value as *mut i32 as *mut core::ffi::c_void,
                )
                .ok()?;
            }
            values.push(value);
        }
        Some(values)
    }

    /// Convert a single UIA element to its JSON representation.
    ///
    /// Returns `None` for elements that are offscreen, zero-sized, or
    /// otherwise uninteresting.
    fn element_to_json(
        store: &mut RefStore,
        element: &IUIAutomationElement,
        parent_runtime_id: Vec<i32>,
    ) -> Option<Value> {
        let ctrl_type = unsafe { element.CachedControlType().or_else(|_| element.CurrentControlType()).ok()? };
        let role = control_type_to_role(ctrl_type.0 as u32);

        let name = unsafe { element.CachedName().or_else(|_| element.CurrentName()).unwrap_or_default().to_string() };
        let automation_id = unsafe {
            element
                .CachedAutomationId().or_else(|_| element.CurrentAutomationId())
                .unwrap_or_default()
                .to_string()
        };
        let runtime_id = runtime_id(element).unwrap_or_default();
        let class_name = unsafe { element.CachedClassName().or_else(|_| element.CurrentClassName()).unwrap_or_default().to_string() };

        // Bounding rectangle.
        let rect = unsafe { element.CachedBoundingRectangle().or_else(|_| element.CurrentBoundingRectangle()).ok()? };

        // Skip invisible / offscreen elements.
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return None;
        }

        let is_offscreen = unsafe {
            element
                .CachedIsOffscreen().or_else(|_| element.CurrentIsOffscreen())
                .map(|value| value.as_bool())
                .unwrap_or(true)
        };
        if is_offscreen {
            return None;
        }

        // Capabilities.
        let is_enabled = unsafe {
            element
                .CachedIsEnabled().or_else(|_| element.CurrentIsEnabled())
                .map(|value| value.as_bool())
                .unwrap_or(false)
        };
        let is_keyboard_focusable = unsafe {
            element
                .CachedIsKeyboardFocusable().or_else(|_| element.CurrentIsKeyboardFocusable())
                .map(|value| value.as_bool())
                .unwrap_or(false)
        };
        let is_password = unsafe {
            element
                .CachedIsPassword().or_else(|_| element.CurrentIsPassword())
                .map(|value| value.as_bool())
                .unwrap_or(false)
        };
        let value_pattern = unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .ok()
        };
        let value = value_pattern
            .as_ref()
            .and_then(|pattern| unsafe { pattern.CurrentValue().ok() })
            .map(|value| value.to_string())
            .unwrap_or_default();
        let value_read_only = value_pattern
            .as_ref()
            .and_then(|pattern| unsafe { pattern.CurrentIsReadOnly().ok() })
            .map(|read_only| read_only.as_bool());
        let signals = ElementAnnotationSignals {
            invoke: pattern_available(element, UIA_IsInvokePatternAvailablePropertyId),
            toggle: pattern_available(element, UIA_IsTogglePatternAvailablePropertyId),
            selection_item: pattern_available(
                element,
                UIA_IsSelectionItemPatternAvailablePropertyId,
            ),
            expand_collapse: pattern_available(
                element,
                UIA_IsExpandCollapsePatternAvailablePropertyId,
            ),
            legacy_default_action: legacy_default_action_available(element),
            value: pattern_available(element, UIA_IsValuePatternAvailablePropertyId),
            text: pattern_available(element, UIA_IsTextPatternAvailablePropertyId),
            value_read_only,
        };
        let can_press = is_enabled && annotation_can_press(&signals);
        let can_set_value = is_enabled && annotation_can_set_text(&signals);
        let can_scroll = pattern_available(element, UIA_IsScrollPatternAvailablePropertyId);

        let eref = store.insert_element(NativeHandle::new(0));

        Some(json!({
            "ref": eref.to_string(),
            "role": role,
            "label": name,
            "automationId": automation_id,
            "runtimeId": runtime_id,
            "parentRuntimeId": parent_runtime_id,
            "className": class_name,
            "value": value,
            "isPassword": is_password,
            "bounds": {
                "x": rect.left,
                "y": rect.top,
                "width": w,
                "height": h,
            },
            "capabilities": {
                "isEnabled": is_enabled,
                "isOffscreen": is_offscreen,
                "isKeyboardFocusable": is_keyboard_focusable,
                "canInvoke": signals.invoke,
                "canPress": can_press,
                "canSetValue": can_set_value,
                "canScroll": can_scroll,
            },
        }))
    }

    pub fn read_live_text(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<String, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        Ok(read_text_from_element(&element))
    }

    pub fn live_elements(hwnd: isize) -> Result<Vec<Value>, String> {
        let mut store = RefStore::new();
        uia_extract(&mut store, hwnd)
    }

    pub struct ElementSnapshot {
        pub rect: (f64, f64, f64, f64),
        pub runtime_id: Vec<i32>,
    }

    pub enum PressResult {
        Invoked,
        Toggled(bool),
        Selected(bool),
        Expanded,
        LegacyDefaultAction,
        NoPattern,
    }

    pub enum SetTextResult {
        Set { value: String },
        NoPattern,
    }

    pub enum ScrollResult {
        Scrolled,
        NoPattern,
    }

    pub fn snapshot(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<ElementSnapshot, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        let rect = unsafe {
            element
                .CurrentBoundingRectangle()
                .map_err(|e| format!("CurrentBoundingRectangle: {e}"))?
        };
        Ok(ElementSnapshot {
            rect: (
                f64::from(rect.left),
                f64::from(rect.top),
                f64::from(rect.right - rect.left),
                f64::from(rect.bottom - rect.top),
            ),
            runtime_id: runtime_id(&element).unwrap_or_default(),
        })
    }

    pub fn ensure_enabled(hwnd: isize, runtime_id_target: &[i32], automation_id: &str) -> Result<(), String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        ensure_element_enabled(&element)
    }

    fn ensure_element_enabled(element: &IUIAutomationElement) -> Result<(), String> {
        let enabled = unsafe { element.CurrentIsEnabled() }
            .map_err(|e| format!("Cannot verify control enabled state before input: {e}"))?;
        if !enabled.as_bool() {
            return Err("Target control is disabled; input was not sent".to_owned());
        }
        Ok(())
    }

    pub fn press(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<PressResult, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        ensure_element_enabled(&element)?;
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
        } {
            unsafe {
                pattern.Invoke().map_err(|e| format!("Invoke: {e}"))?;
            }
            return Ok(PressResult::Invoked);
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        } {
            unsafe {
                pattern.Toggle().map_err(|e| format!("Toggle: {e}"))?;
            }
            let state = unsafe {
                pattern
                    .CurrentToggleState()
                    .map(|s| s.0 != 0)
                    .unwrap_or(false)
            };
            return Ok(PressResult::Toggled(state));
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                UIA_SelectionItemPatternId,
            )
        } {
            unsafe {
                pattern.Select().map_err(|e| format!("Select: {e}"))?;
            }
            let selected = unsafe {
                pattern
                    .CurrentIsSelected()
                    .map(|b| b.as_bool())
                    .unwrap_or(false)
            };
            return Ok(PressResult::Selected(selected));
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                UIA_ExpandCollapsePatternId,
            )
        } {
            unsafe {
                pattern.Expand().map_err(|e| format!("Expand: {e}"))?;
            }
            return Ok(PressResult::Expanded);
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                UIA_LegacyIAccessiblePatternId,
            )
        } {
            let default_action = unsafe {
                pattern
                    .CurrentDefaultAction()
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            };
            if !default_action.trim().is_empty() {
                unsafe {
                    pattern
                        .DoDefaultAction()
                        .map_err(|e| format!("DoDefaultAction: {e}"))?;
                }
                return Ok(PressResult::LegacyDefaultAction);
            }
        }
        Ok(PressResult::NoPattern)
    }

    // Discovery-only metadata. Actions still resolve live elements and patterns.
    fn pattern_available(element: &IUIAutomationElement, property_id: UIA_PROPERTY_ID) -> bool {
        unsafe {
            element.GetCachedPropertyValue(property_id).ok()
                .and_then(|value| bool::try_from(&value).ok())
                .or_else(|| element.GetCurrentPropertyValue(property_id).ok()
                    .and_then(|value| bool::try_from(&value).ok()))
                .unwrap_or(false)
        }
    }

    fn legacy_default_action_available(element: &IUIAutomationElement) -> bool {
        if !pattern_available(element, UIA_IsLegacyIAccessiblePatternAvailablePropertyId) {
            return false;
        }
        unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(
                    UIA_LegacyIAccessiblePatternId,
                )
                .ok()
                .and_then(|pattern| pattern.CurrentDefaultAction().ok())
                .map(|action| !action.to_string().trim().is_empty())
                .unwrap_or(false)
        }
    }

    pub fn set_text(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        text: &str,
    ) -> Result<SetTextResult, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
        {
            let value = BSTR::from(text);
            unsafe {
                pattern
                    .SetValue(&value)
                    .map_err(|e| format!("SetValue: {e}"))?;
            }
            let value = unsafe {
                pattern
                    .CurrentValue()
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            };
            return Ok(SetTextResult::Set { value });
        }
        Ok(SetTextResult::NoPattern)
    }

    pub fn focus(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<(), String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        unsafe { element.SetFocus().map_err(|e| format!("SetFocus: {e}")) }
    }

    pub fn scroll(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        x: f64,
        y: f64,
    ) -> Result<ScrollResult, String> {
        let (_com, _uia, element) = resolve(hwnd, runtime_id_target, automation_id)?;
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
        } {
            let horizontal = if x > 0.0 {
                ScrollAmount_SmallIncrement
            } else if x < 0.0 {
                ScrollAmount_SmallDecrement
            } else {
                ScrollAmount_NoAmount
            };
            let vertical = if y > 0.0 {
                ScrollAmount_SmallIncrement
            } else if y < 0.0 {
                ScrollAmount_SmallDecrement
            } else {
                ScrollAmount_NoAmount
            };
            unsafe {
                pattern
                    .Scroll(horizontal, vertical)
                    .map_err(|e| format!("Scroll: {e}"))?;
            }
            return Ok(ScrollResult::Scrolled);
        }
        Ok(ScrollResult::NoPattern)
    }

    pub fn occlusion_ok(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
        x: f64,
        y: f64,
    ) -> Result<bool, String> {
        let (_com, uia, target) = resolve(hwnd, runtime_id_target, automation_id)?;
        let hit = unsafe {
            uia.ElementFromPoint(POINT {
                x: x.round() as i32,
                y: y.round() as i32,
            })
            .map_err(|e| format!("ElementFromPoint: {e}"))?
        };
        let target_id = runtime_id(&target).unwrap_or_default();
        let hit_id = runtime_id(&hit).unwrap_or_default();
        if !target_id.is_empty() && target_id == hit_id {
            return Ok(true);
        }
        let walker = unsafe {
            uia.ControlViewWalker()
                .map_err(|e| format!("ControlViewWalker: {e}"))?
        };
        Ok(is_ancestor(&walker, &target_id, hit) || is_ancestor(&walker, &hit_id, target))
    }

    fn is_ancestor(
        walker: &IUIAutomationTreeWalker,
        ancestor_id: &[i32],
        mut element: IUIAutomationElement,
    ) -> bool {
        if ancestor_id.is_empty() {
            return false;
        }
        for _ in 0..64 {
            let Some(parent) = (unsafe { walker.GetParentElement(&element).ok() }) else {
                return false;
            };
            let parent_id = runtime_id(&parent).unwrap_or_default();
            if parent_id == ancestor_id {
                return true;
            }
            element = parent;
        }
        false
    }

    fn resolve(
        hwnd: isize,
        runtime_id_target: &[i32],
        automation_id: &str,
    ) -> Result<(ComGuard, IUIAutomation, IUIAutomationElement), String> {
        resolve_with_mode(hwnd, runtime_id_target, automation_id, false)
    }

    fn resolve_for_read(
        hwnd: isize, runtime_id_target: &[i32], automation_id: &str,
    ) -> Result<(ComGuard, IUIAutomation, IUIAutomationElement), String> {
        resolve_with_mode(hwnd, runtime_id_target, automation_id, true)
    }

    fn resolve_with_mode(
        hwnd: isize, runtime_id_target: &[i32], automation_id: &str, read_only: bool,
    ) -> Result<(ComGuard, IUIAutomation, IUIAutomationElement), String> {
        let mut identity = ElementIdentityResolver::new(runtime_id_target, automation_id)?;
        let com = ComGuard::new()?;
        let started = Instant::now();
        // Resolution is read-only even when its caller will subsequently mutate.
        // Capture the provider defaults so finite lookup timeouts cannot turn a
        // later Invoke timeout into a misleading pre-dispatch stale-reference error.
        let action_client = if read_only { None } else {
            let modern: IUIAutomation2 = unsafe {
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("Create action resolution client: {e}"))?
            };
            let connection = unsafe { modern.ConnectionTimeout() }
                .map_err(|e| format!("Read action connection timeout: {e}"))?;
            let transaction = unsafe { modern.TransactionTimeout() }
                .map_err(|e| format!("Read action transaction timeout: {e}"))?;
            unsafe {
                modern.SetConnectionTimeout(2_000)
                    .map_err(|e| format!("Set action resolution connection timeout: {e}"))?;
                modern.SetTransactionTimeout(3_000)
                    .map_err(|e| format!("Set action resolution transaction timeout: {e}"))?;
            }
            Some((modern, connection, transaction))
        };
        let uia: IUIAutomation = match &action_client {
            Some((modern, _, _)) => modern.cast()
                .map_err(|e| format!("Action resolution base interface: {e}"))?,
            None => read_only_client()?,
        };
        let read_budget_available = || -> Result<(), String> {
            let (connection, transaction) = crate::uia_resolution::timeouts(
                started.elapsed().as_millis(), EXTRACTION_BUDGET_MS)?;
            if let Some((modern, _, _)) = &action_client {
                unsafe {
                    modern.SetConnectionTimeout(connection)
                        .map_err(|e| format!("Update resolution connection timeout: {e}"))?;
                    modern.SetTransactionTimeout(transaction)
                        .map_err(|e| format!("Update resolution transaction timeout: {e}"))?;
                }
            }
            Ok(())
        };
        let resolved = (|| -> Result<IUIAutomationElement, String> {
            read_budget_available()?;
            let root = unsafe {
                uia.ElementFromHandle(HWND(hwnd as *mut _))
                    .map_err(|e| format!("ElementFromHandle: {e}"))?
            };
            read_budget_available()?;
            if !runtime_id_target.is_empty() && identity.matches(runtime_id(&root).as_deref(), "") {
                return Ok(root);
            }
            // UIA RuntimeId is exposed as a SAFEARRAY and is not reliably accepted by
            // CreatePropertyCondition across providers/windows-rs VARIANT conversion,
            // so use AutomationId as the fast server-side lookup when available and
            // keep RuntimeId as the authoritative equality check/fallback scan.
            if !automation_id.is_empty() && !runtime_id_target.is_empty() {
                read_budget_available()?;
                let value = VARIANT::from(automation_id);
                if let Ok(condition) =
                    unsafe { uia.CreatePropertyCondition(UIA_AutomationIdPropertyId, &value) }
                {
                    read_budget_available()?;
                    if let Ok(element) = unsafe { root.FindFirst(TreeScope_Subtree, &condition) } {
                        read_budget_available()?;
                        if identity.matches(runtime_id(&element).as_deref(), "") {
                            return Ok(element);
                        }
                    }
                }
            }

            read_budget_available()?;
            let condition = unsafe {
                uia.CreateTrueCondition()
                    .map_err(|e| format!("CreateTrueCondition: {e}"))?
            };
            read_budget_available()?;
            let found = unsafe {
                root.FindAll(TreeScope_Subtree, &condition)
                    .map_err(|e| format!("FindAll: {e}"))?
            };
            read_budget_available()?;
            let count = unsafe {
                found
                    .Length()
                    .map_err(|e| format!("ElementArray.Length: {e}"))?
            };
            for i in 0..count {
                read_budget_available()?;
                let element = unsafe {
                    found
                        .GetElement(i)
                        .map_err(|e| format!("GetElement({i}): {e}"))?
                };
                read_budget_available()?;
                if !runtime_id_target.is_empty() {
                    if identity.matches(runtime_id(&element).as_deref(), "") {
                        return Ok(element);
                    }
                    continue;
                }
                let candidate_id = unsafe {
                    element.CurrentAutomationId()
                        .map_err(|e| format!("CurrentAutomationId: {e}"))?.to_string()
                };
                identity.observe(None, &candidate_id, element);
            }
            identity.finish()
        })();
        let element = crate::uia_resolution::finish(resolved, || {
            if let Some((modern, connection, transaction)) = &action_client {
                unsafe {
                    modern.SetConnectionTimeout(*connection)
                        .map_err(|e| format!("Restore action connection timeout; input was not sent: {e}"))?;
                    modern.SetTransactionTimeout(*transaction)
                        .map_err(|e| format!("Restore action transaction timeout; input was not sent: {e}"))?;
                }
            }
            Ok(())
        }, || crate::uia_resolution::timeouts(
            started.elapsed().as_millis(), EXTRACTION_BUDGET_MS).map(|_| ()))?;
        Ok((com, uia, element))
    }

    fn read_text_from_element(element: &IUIAutomationElement) -> String {
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
        {
            if let Ok(range) = unsafe { pattern.DocumentRange() } {
                if let Ok(value) = unsafe { range.GetText(-1) } {
                    let text = value.to_string();
                    if !text.is_empty() {
                        return text;
                    }
                }
            }
        }
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
        {
            if let Ok(value) = unsafe { pattern.CurrentValue() } {
                let text = value.to_string();
                if !text.is_empty() {
                    return text;
                }
            }
        }
        unsafe { element.CurrentName().unwrap_or_default().to_string() }
    }

    // -----------------------------------------------------------------------
    // COM lifetime guard
    // -----------------------------------------------------------------------

    /// Calls `CoInitializeEx` on construction and `CoUninitialize` on drop.
    struct ComGuard;

    impl ComGuard {
        fn new() -> Result<Self, String> {
            // SAFETY: COM must be initialised for the calling thread before
            // any UIA calls.  S_OK (0) and S_FALSE (1) are both success
            // indicators; only a negative HRESULT means failure.
            let hr = unsafe { CoInitializeEx(Some(std::ptr::null()), COINIT_APARTMENTTHREADED) };
            if hr.0 < 0 {
                return Err(format!("CoInitializeEx failed: {:#010x}", hr.0));
            }
            Ok(Self)
        }
    }

    impl Drop for ComGuard {
        fn drop(&mut self) {
            // SAFETY: each successful CoInitializeEx (including S_FALSE) must
            // be balanced with a CoUninitialize.
            unsafe {
                CoUninitialize();
            }
        }
    }
}

#[cfg(windows)]
pub use native::{
    ensure_enabled, focus, live_elements, occlusion_ok, press, read_live_text, scroll, set_text, snapshot,
    uia_extract, ElementSnapshot, PressResult, ScrollResult, SetTextResult,
};

#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub struct ElementSnapshot {
    pub rect: (f64, f64, f64, f64),
    pub runtime_id: Vec<i32>,
}
#[cfg(not(windows))]
pub enum PressResult {
    Invoked,
    Toggled(bool),
    Selected(bool),
    Expanded,
    LegacyDefaultAction,
    NoPattern,
}
#[cfg(not(windows))]
pub enum SetTextResult {
    Set { value: String },
    NoPattern,
}
#[cfg(not(windows))]
pub enum ScrollResult {
    Scrolled,
    NoPattern,
}
#[cfg(not(windows))]
pub fn read_live_text(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<String, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn live_elements(_hwnd: isize) -> Result<Vec<Value>, String> {
    Ok(Vec::new())
}
#[cfg(not(windows))]
pub fn snapshot(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<ElementSnapshot, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn ensure_enabled(_hwnd: isize, _runtime_id: &[i32], _automation_id: &str) -> Result<(), String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn press(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
) -> Result<PressResult, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn set_text(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _text: &str,
) -> Result<SetTextResult, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn focus(_hwnd: isize, _runtime_id: &[i32], _automation_id: &str) -> Result<(), String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn scroll(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _x: f64,
    _y: f64,
) -> Result<ScrollResult, String> {
    Err("UIA is only supported on Windows".to_owned())
}
#[cfg(not(windows))]
pub fn occlusion_ok(
    _hwnd: isize,
    _runtime_id: &[i32],
    _automation_id: &str,
    _x: f64,
    _y: f64,
) -> Result<bool, String> {
    Err("UIA is only supported on Windows".to_owned())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod unit_tests {
    use super::*;
    use crate::refs::NativeHandle;
    use serde_json::json;

    #[test]
    fn replaced_control_cannot_reuse_an_observed_automation_id() {
        let mut resolution = ElementIdentityResolver::new(&[42, 7], "Insert").unwrap();
        resolution.observe(Some(&[42, 8]), "Insert", "replacement button");
        resolution.observe(None, "Insert", "provider lost its runtime identity");
        assert_eq!(resolution.finish().unwrap_err(), "Element reference is stale");
    }

    #[test]
    fn runtime_identity_survives_reordering_and_name_changes() {
        let mut resolution = ElementIdentityResolver::new(&[42, 7], "Insert").unwrap();
        resolution.observe(Some(&[42, 8]), "Insert", "other button with same automation ID");
        resolution.observe(Some(&[42, 7]), "RenamedInsert", "observed button");
        assert_eq!(resolution.finish().unwrap(), "observed button");
    }

    #[test]
    fn automation_only_identity_requires_one_live_match() {
        let mut unique = ElementIdentityResolver::new(&[], "Save").unwrap();
        unique.observe(None, "Cancel", "other control");
        unique.observe(Some(&[42, 7]), "Save", "save button");
        assert_eq!(unique.finish().unwrap(), "save button");
        let mut duplicate = ElementIdentityResolver::new(&[], "Save").unwrap();
        duplicate.observe(Some(&[42, 7]), "Save", "ribbon save");
        duplicate.observe(Some(&[42, 8]), "Save", "dialog save");
        assert_eq!(duplicate.finish().unwrap_err(), "Element reference is ambiguous");
    }

    #[test]
    fn missing_identity_never_resolves_to_an_arbitrary_root() {
        assert!(ElementIdentityResolver::<()>::new(&[], "").is_err());
        let mut absent = ElementIdentityResolver::new(&[], "Insert").unwrap();
        absent.observe(Some(&[]), "", "root with no identity");
        assert_eq!(absent.finish().unwrap_err(), "Element reference is stale");
    }

    #[test]
    fn provider_failure_is_explicit_and_never_creates_an_element_ref() {
        let failed = failed_extraction("FindAll: provider timed out");
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0]["diagnosticOnly"], true);
        assert_eq!(failed[0]["extractionDiagnostics"]["status"], "incomplete");
        assert_eq!(failed[0]["extractionDiagnostics"]["rawTruncated"], true);
        assert!(failed[0].get("ref").is_none());
    }

    #[test]
    fn worker_refs_never_alias_previous_parent_observations() {
        let mut store = RefStore::new();
        assert_eq!(store.insert_element(NativeHandle::new(0)).to_string(), "@e1");
        let elements = adopt_worker_elements(&mut store, vec![
            json!({"ref":"@e1", "runtimeId":[7, 42], "parentRuntimeId":[7, 1]}),
            json!({"ref":"@e2", "runtimeId":[7, 43]}),
            failed_extraction("UIA read worker deadline exceeded; terminated and reaped")[0].clone(),
        ]);
        assert_eq!(elements[0]["ref"], "@e2");
        assert_eq!(elements[1]["ref"], "@e3");
        assert_eq!(elements[0]["runtimeId"], json!([7, 42]));
        assert_eq!(elements[0]["parentRuntimeId"], json!([7, 1]));
        assert_eq!(elements[2]["extractionDiagnostics"]["reason"], "read_timeout");
        assert!(elements[2].get("ref").is_none());
    }

    #[test]
    fn document_after_sidebar_is_retained_within_the_original_budget() {
        let order = super::extraction_order(236, 200, &[220]);
        assert_eq!(order.len(), 200);
        assert_eq!(&order[..3], &[0, 220, 1]);
        assert!(!order.contains(&199));
        assert!(super::extraction_diagnostics(236, order.len(), 200)["rawTruncated"].as_bool().unwrap());
    }

    #[test]
    fn anchor_order_is_unique_bounded_and_keeps_small_trees_complete() {
        assert_eq!(super::extraction_order(4, 200, &[0, 3, 3, 999]), vec![0, 3, 1, 2]);
        assert!(super::extraction_order(0, 200, &[1]).is_empty());
        assert!(super::extraction_order(10, 0, &[1]).is_empty());
        let order = super::extraction_order(500, 200, &(200..220).collect::<Vec<_>>());
        assert_eq!(order.len(), 200);
        assert!(order.contains(&207));
        assert!(!order.contains(&208));
        assert_eq!(order.iter().copied().collect::<std::collections::HashSet<_>>().len(), 200);
        assert_eq!(super::extraction_order(236, 200, &[]), (0..200).collect::<Vec<_>>());
    }

    #[test]
    fn retained_count_does_not_hide_raw_extraction_truncation() {
        let truncated = extraction_diagnostics(500, 200, 60);
        assert_eq!(truncated["rawTruncated"], true);
        assert_eq!(truncated["visibleRetained"], 60);
        let complete = extraction_diagnostics(60, 60, 20);
        assert_eq!(complete["rawTruncated"], false);
    }

    // -- Platform support check (non-Windows) -------------------------------

    #[test]
    #[cfg(not(windows))]
    fn test_extract_elements_empty_on_non_windows() {
        let mut store = RefStore::new();
        let result = extract_elements(&mut store, 0);
        assert!(result.is_empty());
    }

    // -- Role mapping (cross-platform) --------------------------------------

    #[test]
    fn test_control_type_to_role_edit() {
        assert_eq!(control_type_to_role(50004), "edit");
    }

    #[test]
    fn test_control_type_to_role_button() {
        assert_eq!(control_type_to_role(50000), "button");
    }

    #[test]
    fn test_control_type_to_role_checkbox() {
        assert_eq!(control_type_to_role(50002), "checkbox");
    }

    #[test]
    fn test_control_type_to_role_radio() {
        assert_eq!(control_type_to_role(50013), "radio");
    }

    #[test]
    fn test_control_type_to_role_window() {
        assert_eq!(control_type_to_role(50032), "window");
    }

    #[test]
    fn test_control_type_to_role_pane() {
        assert_eq!(control_type_to_role(50033), "pane");
    }

    #[test]
    fn test_control_type_to_role_menu_item() {
        assert_eq!(control_type_to_role(50011), "menuItem");
    }

    #[test]
    fn test_control_type_to_role_list_item() {
        assert_eq!(control_type_to_role(50007), "listItem");
    }

    #[test]
    fn test_control_type_to_role_document() {
        assert_eq!(control_type_to_role(50030), "document");
    }

    // Official UIAutomationClient.h identifiers, independent of local constants.
    #[test]
    fn official_control_type_ids_preserve_semantic_roles() {
        for (id, role) in [
            (50006, "image"), (50031, "button"), (50007, "listItem"), (50011, "menuItem"),
            (50012, "progressBar"), (50013, "radio"), (50014, "scrollBar"),
            (50015, "slider"), (50017, "statusBar"), (50019, "tabItem"),
            (50020, "text"), (50021, "toolBar"), (50022, "toolTip"),
            (50023, "tree"), (50024, "treeItem"), (50038, "separator"),
        ] {
            assert_eq!(control_type_to_role(id), role, "official control ID {id}");
        }
    }

    #[test]
    fn test_control_type_to_role_unknown() {
        assert_eq!(control_type_to_role(99999), "unknown");
        assert_eq!(control_type_to_role(0), "unknown");
    }

    // -- Element JSON shape (cross-platform) --------------------------------

    #[test]
    fn test_element_json_shape() {
        let mut store = RefStore::new();
        let eref = store.insert_element(NativeHandle::new(0));
        let ref_str = eref.to_string();

        let element = json!({
            "ref": ref_str,
            "role": "edit",
            "label": "Test Label",
            "automationId": "1001",
            "runtimeId": [42, 7, 9],
            "className": "Edit",
            "bounds": {
                "x": 10,
                "y": 20,
                "width": 100,
                "height": 30,
            },
            "capabilities": {
                "isEnabled": true,
                "isOffscreen": false,
                "isKeyboardFocusable": true,
            },
        });

        assert_eq!(element["ref"].as_str(), Some("@e1"));
        assert_eq!(element["role"].as_str(), Some("edit"));
        assert_eq!(element["label"].as_str(), Some("Test Label"));
        assert_eq!(element["automationId"].as_str(), Some("1001"));
        let runtime_id = element["runtimeId"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_i64().unwrap() as i32)
            .collect::<Vec<_>>();
        assert_eq!(runtime_id, vec![42, 7, 9]);
        assert_eq!(element["className"].as_str(), Some("Edit"));
        assert!(element["bounds"].is_object());
        assert_eq!(element["bounds"]["x"], 10);
        assert_eq!(element["bounds"]["y"], 20);
        assert_eq!(element["bounds"]["width"], 100);
        assert_eq!(element["bounds"]["height"], 30);
        assert!(element["capabilities"].is_object());
        assert_eq!(element["capabilities"]["isEnabled"], true);
        assert_eq!(element["capabilities"]["isOffscreen"], false);
        assert_eq!(element["capabilities"]["isKeyboardFocusable"], true);
    }

    #[test]
    fn pressability_annotation_matrix_matches_grounding_ladder() {
        let base = ElementAnnotationSignals::default();
        assert!(!annotation_can_press(&base));

        let cases = [
            ElementAnnotationSignals {
                invoke: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                toggle: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                selection_item: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                expand_collapse: true,
                ..base.clone()
            },
            ElementAnnotationSignals {
                legacy_default_action: true,
                ..base.clone()
            },
        ];
        for signals in cases {
            assert!(annotation_can_press(&signals));
        }
    }

    #[test]
    fn text_editable_annotation_matrix_matches_set_text_grounding() {
        assert!(!annotation_can_set_text(
            &ElementAnnotationSignals::default()
        ));
        assert!(annotation_can_set_text(&ElementAnnotationSignals {
            value: true,
            value_read_only: Some(false),
            ..Default::default()
        }));
        assert!(!annotation_can_set_text(&ElementAnnotationSignals {
            value: true,
            value_read_only: Some(true),
            ..Default::default()
        }));
        assert!(annotation_can_set_text(&ElementAnnotationSignals {
            text: true,
            ..Default::default()
        }));
    }

    #[test]
    fn test_ax_targets_response_shape() {
        // Simulate the screenshot response with axTargets.
        let mut store = RefStore::new();
        let eref = store.insert_element(NativeHandle::new(0));
        let ref_str = eref.to_string();

        let response = json!({
            "target": "@w1",
            "capture": {
                "stateId": "s-0",
                "width": 800,
                "height": 600,
                "imageFormat": "png",
                "imageBase64": "dummy",
            },
            "axTargets": [
                {
                    "ref": ref_str,
                    "role": "edit",
                    "label": "Address bar",
                    "automationId": "1001",
                    "className": "Edit",
                    "bounds": { "x": 0, "y": 0, "width": 800, "height": 30 },
                    "capabilities": {
                        "isEnabled": true,
                        "isOffscreen": false,
                        "isKeyboardFocusable": true,
                    },
                }
            ],
            "warnings": [],
        });

        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert!(response["capture"].is_object());
        assert!(response["warnings"].is_array());
        assert!(response["axTargets"].is_array());

        let targets = response["axTargets"].as_array().unwrap();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0]["ref"].as_str(), Some("@e1"));
        assert_eq!(targets[0]["role"].as_str(), Some("edit"));
    }
}

#[cfg(test)]
mod ancestry_cache_tests {
    use super::retained_ancestor;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn shared_ancestors_preserve_boundary_with_far_fewer_provider_calls() {
        let retained = HashSet::from(["0".to_string()]);
        let mut cache = HashMap::new();
        let mut reads = 0;
        for leaf in 100..1100 {
            assert_eq!(retained_ancestor(leaf, &retained, &mut cache,
                |id| Some(id.to_string()),
                |id| { reads += 1; Some(if *id >= 100 { 10 } else { id - 1 }) }),
                Some("0".to_string()));
        }
        assert_eq!(reads, 1010); // Uncached: 1000 * 11 parent queries.
    }

    #[test]
    fn nearest_retained_branch_is_not_replaced_by_another_boundary() {
        let retained = HashSet::from(["0".to_string(), "5".to_string()]);
        let mut cache = HashMap::new();
        for (leaf, ancestor) in [(100, "5"), (101, "5"), (102, "0")] {
            assert_eq!(retained_ancestor(leaf, &retained, &mut cache,
                |id| Some(id.to_string()),
                |id| Some(match *id { 100 | 101 => 10, 102 => 4, other => other - 1 })),
                Some(ancestor.to_string()));
        }
    }

    #[test]
    fn failed_or_depth_limited_walks_do_not_invent_or_cache_boundaries() {
        let retained = HashSet::from(["0".to_string()]);
        let mut cache = HashMap::new();
        assert_eq!(retained_ancestor(100, &retained, &mut cache,
            |id| Some(id.to_string()), |id| Some(id - 1)), None);
        assert!(cache.is_empty());
        assert_eq!(retained_ancestor(2, &retained, &mut cache,
            |id| Some(id.to_string()), |_| None), None);
        assert!(cache.is_empty());
        assert_eq!(retained_ancestor(2, &retained, &mut cache,
            |_| Some(String::new()), |_| Some(0)), None);
        assert!(cache.is_empty());
    }
}
