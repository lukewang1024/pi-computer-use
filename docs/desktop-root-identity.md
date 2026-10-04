# Keep desktop actions on their observed root

A desktop state, its native look, element references, write lock and successor
observation must belong to the same window. An application's modal dialog may
belong to another document in the same process. Its foreground rank does not
authorize changing the target of an existing state.

Current-root resolution retains the root selected by `observe_ui`. Rootless
observation can discover the frontmost window, and `find_roots` followed by an
explicit observation can select a newly opened dialog. Actions on that dialog
then use its own state and references.

After resolving the current window, action dispatch validates the state again.
A changed process, window ID or native root reference rejects the action before
native input is sent. Observe the intended current root to obtain new references;
never automatically replay an action whose dispatch outcome is unknown.

This does not replace native foreground verification. Physical input still needs
the exact interactive window, and semantic actions still need live native
references. A matching process ID alone grants neither permission.

`scripts/check-native-root-pin.mjs` exercises the public executors with a
controlled backend: unrelated foreground modal, focused document, deliberate
dialog action, two window remappings, and invalid references. It dispatches no
real native input. Desktop application acceptance is a separate requirement.
