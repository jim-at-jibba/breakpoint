# Pane review fixes

Implement the eight findings accepted by the request to fix the branch review:

- Use named parameter objects for pane lifecycle methods with booleans or three-plus arguments.
- Keep the last committed snapshot and its live canvas mounted during refresh and failure. Recovery status remains visible in app-owned chrome; an authoritative project change still replaces the pane set.
- Reject absent pane ids using own-key membership, including Object prototype names, with `PANE_NOT_FOUND` and no state/log changes.
- Force guest web security on and insecure mixed content off, regardless of renderer preferences.
- Install deny-by-default permission check and request handlers on every guest session before loading content. There are no configured permission grants today.
- Accept only HTTP(S) project start URLs and guest sources. Guard subsequent page navigation, redirects, and programmatic guest loads in main, without restricting HTTP(S) origins or ordinary embedded resources.
- Exercise guest security through real Electron behavior, including cross-origin reads, session permissions, and disallowed schemes.
- Exercise snapshot recovery with live guest identity, navigation, history, and unsaved page state retained through refresh/failure/retry.

Unresolved questions: none.
