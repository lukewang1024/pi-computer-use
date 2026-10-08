# Publishing checked Workbench packages

The formal release first looks for a successful main-push CI run at the exact
selected commit. Both the run and its checked-candidate artifact must belong to
this repository and main branch. Pull request and fork artifacts are ineligible.
The entire CI run must have completed successfully, and the artifact must not
have expired. Ambiguous artifacts or API failures stop publication.

An already running main CI is observed for at most 20 minutes. If no eligible
checked package is available, the release uses the existing complete native
build and package-validation workflow. No asset or test gate is removed.

Publication downloads the selected checked tarball without rebuilding or
repacking it. The verifier checks its builder run ID, exact source commit,
package version, archive and helper hashes, safe archive entries, and packaged
source bytes. Provenance records both the builder and publisher run IDs. An
incorrect receipt or package stops before release creation. Mac installations
continue to use LOCAL_BUILD with the existing local signing identity pin.

This avoids building the same source twice when main CI already produced its
checked package. It does not establish runtime performance or desktop task
success; those require managed deployment and live acceptance.
