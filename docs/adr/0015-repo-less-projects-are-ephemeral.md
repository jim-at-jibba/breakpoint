# A project without a repo path is ephemeral

`Project.repoPath` becomes `string | null`. A project that has one is identified by it and
is stored, exactly as before. A project that does not has no identity at all: it is never
written to the store, and it lives as long as the window that opened it.

This is what lets the app be opened from the Dock rather than only from `breakpoint .`.
The two entry points ask different questions and get different answers — a repo path opens
the project for that repo, a typed URL opens a canvas pointed at it — and `startUrl`,
panes, layout, zoom and sessions are the same shape either way. Only identity differs.

PRD §8's launch table already specified `breakpoint open <url>` as "Open a URL in the
current project, **or an ad hoc one**" in Phase 1; the ad-hoc half was never built. This
records what it means rather than deciding something new.

## Consequences

Nothing new reaches the file system, so `PROJECT_FILE_VERSION` stays 3 and there is no
migration. `ProjectService.save` skips the store when `repoPath` is null; the store's
filename hash ([`projectFileName`](../../src/shared/project.ts)) keeps repo paths as its
only input, so no second identity scheme is invented alongside it.

Quitting loses an ad-hoc canvas. That is the intended behaviour and not a gap to be fixed
later by accident: a canvas earns durability by being given a repo, and an explicit way to
save one without a repo is deferred until something actually asks for it. Persistence is a
promotion, not a property.

`Project` stays one concept. The alternative — a second noun for the repo-less case — means
every route, error and doc has to say which of the two it means, permanently, to describe a
difference of one nullable field. `CONTEXT.md`'s glossary entry is amended instead, and its
_Avoid_ list already rejects `workspace`, `site` and `app`.

This narrows issue #6's user story 3 ("a project is identified by its repo path") to
projects that have one. The story's intent — the same repo always reopens the same project
— is untouched.

## Why the URL cannot stand in for the repo path

It is tempting to key a repo-less project on its URL, and so to match a typed URL back onto
a stored project. Both are refused.

`createProject` takes no URL. Every project is born with
`startUrl: 'http://localhost:3000'` and an allow-list holding that same origin, and only
diverges if something later navigates it. The default value would be the lookup key, so
typing `localhost:3000` matches every project that has never been navigated away from. That
is a certain collision, not a rare one.

The deeper reason survives any amount of disambiguation: **a port is a lease, not an
identifier.** One dev server holds `:3000` at a time, whichever booted first. A lookup can
therefore resolve to the right project, restore the right panes, and still render a
different project's application — right about the intent and wrong about what is on screen.
No picker fixes that, because the ambiguity is in the machine rather than in the input.

So no surface matches a URL onto a stored project, and anything listing projects — a recents
list on the cold-start window above all — is keyed and labelled on the repo path. `name` is
`basename(repoPath)`, which is ambiguous under git worktrees, where the basename is the
worktree directory rather than the repo; a list has to show enough path to tell two apart.

`startUrl` remains stored and remains useful. It answers "where was this project last
pointed", which is a property of a project already identified. It never answers "which
project is this", which is the only question it is bad at.

This is also why ephemeral is the right answer rather than a concession. "What is running on
this port right now" is an honest question that needs no identity, and it is a different
question from "what am I working on". The property that makes a URL useless as a key is the
same one that makes the canvas built from it disposable.
