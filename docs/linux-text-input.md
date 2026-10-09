# Linux native text input

Physical text input plans the entire string before sending key events. `setText`
also plans its select-all chord before clicking the field. Unsupported controls,
unmapped symbols or unavailable modifier keys reject the operation before any
click, select-all or text event. Each dispatched event retains the target PID
and exact foreground-window guards.

The text planner reads the keyboard map once per string and chooses the actual
unshifted or Shift level in the base group. It does not infer Shift from a US
keyboard layout or use symbols found only in another group. Characters use the
Latin-1 or Unicode keysym encoding from the
[X11 protocol](https://xorg.freedesktop.org/archive/X11R7.7/doc/xproto/x11protocol.html).
Mapped Unicode symbols can be planned; a character absent from the available
base-group mapping is rejected before the string is sent.

The current physical planner requires group zero and no active modifiers at
preparation time. This is not general Unicode input support, a full XKB layout
implementation, or proof that a specific application accepted the text. Changes
to keyboard state or mapping during delivery, arbitrary unmapped Unicode,
transport failure after partial delivery and native chooser completion require
further implementation or live acceptance. AT-SPI editable text remains a
separate semantic path when a real editable accessibility object is available.

Physical input maintains a conservative event-attempt ledger. If a failure occurs
after the first XTEST write attempt, the action returns an unknown outcome with
`recoveryRequired: true`, `retrySafe: false`, and possibly held key/button codes.
A release is removed from that set only after its request is acknowledged and
flushed. Batch responses preserve this recovery information at the top level;
they do not convert an unknown partial action into a normal rejection. The
helper does not send blind release events to a different foreground window.
`eventsDispatched` is explicitly labeled as write attempts, not proof that every
attempt reached the server. Rejection before the first write keeps its original
error and does not claim that input occurred.
