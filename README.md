# forge-prime

![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/SURAXY1/forge-prime/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/SURAXY1/forge-prime/reward.svg)

A standalone GitHub-compatible git forge in a single Node process, standard
library only. It serves four surfaces from one in-memory store:

- git smart HTTP: protocol v2 upload-pack (ls-refs, fetch, shallow clones)
  and v0 receive-pack with fast-forward enforcement and report-status
- REST v3 under `/api/v3`: repositories, contents, branches, commits, refs,
  labels, issues, comments and pull requests (including squash/merge/rebase)
- GraphQL v4 at `/api/graphql`, with introspection served from the same
  schema table that executes queries and mutations
- MCP at `/mcp` (JSON-RPC over streamable HTTP): repository, issue and
  pull-request tools acting on the same store

## Run

```sh
node --experimental-strip-types main.ts
```

The process binds an ephemeral port, registers it with
`$MAKEFUN_ENV_URL/register`, and polls `$MAKEFUN_ENV_URL/done` until the
harness ends the trial. With `MAKEFUN_ENV_URL` unset and `PORT` set, it runs
standalone on that port.

## Design notes

- Per-repository mutation epoch: every write bumps the epoch and clears the
  memoised GET serialisations, ref advertisements and fetch packs, so repeat
  reads and clones are served from cache while any mutation invalidates.
- Each git object is deflated at most once (level 1) and its packed form is
  cached on the object; the fetch path never inflates.
- Auth verdicts are cached per credential header.
- MCP `tools/list` is a pre-serialised constant, byte-identical per call.
- Routing is hand-split string work: no regular expressions and no clock
  reads in the request hot paths.

## Layout

- `main.ts` — lifecycle (bind, register, wait for done)
- `server.ts` — node:http front door, auth, dispatch
- `core.ts` — store, git objects, domain operations
- `pack.ts` — packfile codec and pkt-line framing
- `gitserve.ts` — smart HTTP upload/receive pack
- `restapi.ts` — REST v3 routes
- `views.ts` — REST JSON shapes
- `gqlparse.ts`, `gqlschema.ts`, `graphql.ts` — GraphQL parser, schema, executor
- `mcp.ts` — MCP endpoint

Licensed under MIT (see `LICENSE`).
