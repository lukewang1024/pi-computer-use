> Keep deep native controls reachable and retain returned actions when a batch stops.

## Features

- Verify exact window ancestry through deeply nested accessibility controls, with cycle detection and a finite depth bound.
- Stop a batch when its exact source root closes, before sending later actions against that retired root.

## Changelog

- Preserve returned prefix receipts and the failing step when a later native action throws.
- Invalidate old observations and retain quarantine when native completion lacks proof; never fabricate an input-release receipt or replay an action.
- Add native ancestry and public-tool batch interruption regressions from live desktop findings.
