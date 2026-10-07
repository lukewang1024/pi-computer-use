# Browser evaluation response projection

`evaluate_browser` accepts `includeOutline: false` when a caller only needs the bounded evaluation value. The default still includes the complete serialized outline.

This changes returned data only. The tool always refreshes the complete successor snapshot and advances state. Search against the returned state to obtain fresh action references; old states and refs remain subject to normal stale-state rejection. Invalid parameter types are rejected before JavaScript evaluation.

The motivating real article had 13,420 distinct semantic nodes and approximately 5.7 MB responses even without images. Integration tests exercise real CDP transport, successor collection, searching the retained state, stale input refusal, and default compatibility. Runtime latency savings still require live measurement.
