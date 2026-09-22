# The origin allow-list binds automation, not the developer

§7.1 scopes the agent to a project's allowed origins. That constraint is enforced on
navigation arriving over the local socket, and on nothing else. Typing a URL in the address
bar, or clicking a link inside a pane, is never blocked.

## Consequences

This is a dev browser: staging redirects to SSO domains, docs link outward, and a tool that
refuses to follow those is broken. The allow-list exists to bound what automation can reach
on the developer's behalf, which is the only place §7.1 actually cares.

Stated as an explicit no, because "we have an allow-list" invites someone to apply it
uniformly later and call it a security improvement.

## Who may edit the list

The list itself is editable from every surface, including the socket the constraint is
enforced on. That is deliberate, and it is a real limit on what the constraint is worth:
an agent holding the socket can widen the list and then navigate where it likes, so
`ORIGIN_NOT_ALLOWED` bounds an agent that is following its instructions rather than one
that is trying to get around them.

The alternative is a route the CLI cannot reach, which contradicts
[ADR-0005](0005-one-route-table-no-ui-only-routes.md) — the whole point of the single
table is that no surface has behaviour the others lack. Deciding which surface may do
what is the Phase 6 permission tiers' job (PRD 7.7), which arrive with exit code `4` and
a toggle the agent cannot set. Until then the socket is an owner-only door into a process
that can already add panes, remove them and quit the app
([ADR-0008](0008-cli-access-on-by-default.md)), so gating this one route ahead of the
model would buy a guarantee it cannot actually keep.
