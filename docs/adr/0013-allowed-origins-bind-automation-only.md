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
