# Breakpoint

A multi-viewport dev browser for developers and their coding agents. This file is the
glossary: the words this project uses and the ones it deliberately avoids. It holds no
implementation detail — that lives in the PRD, the ADRs and the code.

## Language

### The site

**Site**:
The public web presence for Breakpoint: one landing page plus the Docs, built and
deployed as a single project.
_Avoid_: website, marketing site, docs site

**Docs**:
The public user documentation published under `/docs` on the Site.
_Avoid_: handbook, guide, user docs, public docs

**Internal docs**:
Everything under the repository's `docs/` directory — the PRD, ADRs, handoffs, agent
instructions and design prototypes. None of it is published.
_Avoid_: docs (unqualified — it always means the public ones)

**Design prototype**:
A `.dc.html` file under `docs/design/`, and the source of truth for the layout, tokens
and design decisions it covers.
_Avoid_: mockup, design file, comp

**Demo**:
The mock of the Breakpoint app window shown on the Site. A depiction of the product,
never the product itself.
_Avoid_: preview, playground, sandbox
