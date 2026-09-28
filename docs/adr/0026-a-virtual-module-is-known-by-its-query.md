# A virtual module is known by its query

Astro, Vue and Svelte name the scripts they extract after the file they came from, with a
query saying which part: `Page.astro?astro&type=script&index=0&lang.ts`. Its lines belong to
the extracted script. Resolution read the name as the file and reported the right path at the
wrong line, the one outcome ADR-0020 ranks below failing.

Two rules could tell the two apart. **By content** compares a map's `sourcesContent` with the
file on disk. It would also catch a virtual module that has no query, but it only helps where
a map carries its content. It costs a read inside the deadline. And it cannot help the
arithmetic path at all: on a dev server the frame's URL *is* the virtual module, and no map
is involved. **By query** reads only the name, so it covers both paths and costs nothing.

Resolution therefore uses the query. It lists the keys that leave a file as it is, which are
Vite's `t` and `v` cache-busting. Any other key makes the name a virtual module, and the
location appends as reported with `resolution: "failed"`. We list the keys that are known to
be safe, not the ones known to be virtual, so the list fails safe. A dev server that invents
a new cache-busting key loses resolution for those scripts, and nothing reports a wrong line.

## Consequences

Checked against a real Astro dev server. The frame URL and its inline map's source both carry
the query, and the map's `sourcesContent` is the extracted TypeScript, not the page.

The allow-list declines some names whose lines would have been right. Examples are Vite's
`?worker_file`, `?import`, `?direct` and `?url`, and vue-loader's hash suffixes such as
`App.vue?91b2`. Each of these appends as reported rather than resolving. If the smoke shows
that one of them costs real resolutions, add its key to the list.

A virtual module named with no query at all would still resolve to its namesake. No bundler
in use does this. If one does, content comparison is the addition to make, on the map path,
inside the same deadline.
