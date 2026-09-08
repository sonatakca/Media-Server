# Indexer search

Seyirlik's own search against Newznab-compatible indexers. Nothing here depends
on Prowlarr, Radarr or Sonarr: the runtime path is Seyirlik → indexer, and the
legacy stack could be stopped without affecting it.

## Layers

```
indexerRoutes.ts     three admin routes; releases leave only through a DTO
searchService.ts     one search across providers, merged and ordered
indexerRegistry.ts   configured providers, plus what happened to each
newznabProvider.ts   HTTP: credential, timeout, bounded retry, caps cache
newznab.ts           the protocol: what the XML means
xmlReader.ts         a deliberately restricted XML reader
```

Newznab's XML stops at `newznab.ts`. Everything above it works from
`indexerTypes.ts`, so a second provider protocol is another adapter rather than
a second shape spread through the product.

## Configuration

`SEYIRLIK_INDEXERS` in the non-secret settings file, beside `SEYIRLIK_LIBRARIES`:

```json
[
  {
    "id": "example",
    "name": "Example",
    "type": "newznab",
    "baseUrl": "https://api.example.invalid",
    "apiPath": "/api",
    "protocol": "usenet",
    "enabled": true,
    "apiKeyEnv": "SEYIRLIK_INDEXER_APIKEY_EXAMPLE",
    "categories": { "movie": [2000], "tv": [5000] }
  }
]
```

An entry names **the variable holding its key**, never the key. The value lives
only in the protected secrets file, so rotation is editing one line the service
can read and restarting it — no code change, and no second copy in the database
to drift from this one.

An entry that is enabled with an empty key stops the process at startup. Left
alone it presents as an indexer that finds nothing, which reads like an empty
library rather than a misconfiguration.

## Capabilities

Read from the provider (`t=caps`), never assumed. Category numbering differs
between indexers, and a hard-coded guess does not fail — it quietly searches the
wrong section. Limits come from the same place, so a request is clamped to what
the provider actually allows.

Capabilities are cached (six hours by default) and concurrent reads collapse
into one flight, so a burst of searches on a cold cache does not become a burst
of `caps` requests against a provider that rate-limits. A search whose
capability read fails still runs: the limits are an optimisation, and the
provider clamps whatever it disagrees with.

Note that some providers answer `t=caps` **without** a key and still require one
for `t=search`. Capabilities working is therefore not evidence that the
credential is right.

## Errors

Newznab reports refusal with HTTP 200 and an `<error code=… description=…/>`
body, so a status check alone reads bad credentials as a successful empty
search. Both the status and the envelope are classified into one set of kinds:

| Kind                 | From                                | Retried |
| -------------------- | ----------------------------------- | ------- |
| `auth`               | 401, 403, codes 100–102             | no      |
| `not-found`          | 404, code 300                       | no      |
| `rate-limited`       | 429, code 500                       | yes     |
| `bad-request`        | other 4xx, codes 200–203            | no      |
| `provider-error`     | any other provider code             | no      |
| `malformed-response` | unreadable or implausibly large XML | no      |
| `timeout`            | the request deadline                | yes     |
| `cancelled`          | the caller went away                | no      |
| `unavailable`        | 5xx, transport failure              | yes     |

Retries are bounded and exponential, and only for kinds repeating could fix.

`timeout` and `cancelled` are told apart by the **caller's** signal, not the
internal one: the deadline aborts our own controller, so asking that controller
whether it was aborted answers yes for both — and conflating them silently
disables retry for every timeout.

## Ordering and deduplication

Newest first, ties broken by indexer then identifier, so the same inputs always
produce the same page. This is **not** release selection. Which of two releases
is better — resolution, source, codec, group, size against a profile — belongs
to the phase that has quality profiles; half of that rule here would be a second
ranking to reconcile later.

Duplicates are dropped per indexer, by the identifier that indexer promised is
stable. The same film from two indexers is kept twice: they are two different
things to acquire, from two different providers.

## API

All administrator-only.

| Route                                             | Does                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /ownAPI/v1/indexers`                         | configured indexers, with last success and last failure                                                                    |
| `GET /ownAPI/v1/indexers/:indexerId/capabilities` | what the provider says it supports                                                                                         |
| `POST /ownAPI/v1/indexers/search`                 | search; body takes `kind`, `term`, `imdbId`, `tvdbId`, `season`, `episode`, `categoryIds`, `limit`, `offset`, `indexerIds` |

A search returns `releases`, a per-indexer `indexers` array, and `partial` —
true when some indexer failed while another answered. The search fails only when
every indexer failed.

**There is deliberately no route that fetches an NZB or hands one to a download
client.** That is where discovery stops being discovery and starts changing
somebody's library.

## What never leaves the server

Every Newznab download URL carries the API key in its query string. So:

- `IndexerReleaseDto` has **no field** for it, and `toReleaseDto` is the only
  way a release reaches a caller — one conversion to check, rather than a rule
  each route has to remember.
- Nothing from a transport failure is carried into an error. A `fetch` rejection
  stringifies to a message containing the request URL.
- The indexer layer logs nothing at all.

## Provider health

Indexer status is reported by `GET /indexers`, and is deliberately **not** part
of process readiness. An indexer outage is somebody else's service being down;
it must not make Seyirlik look dead. Status is held in memory because it is an
observation, worthless after a restart, and persisting it would put a second
source of truth beside the configuration it describes.

## The XML reader

Written rather than taken from a package. The shape is narrow, the input is
third-party, and what it refuses matters more than what it supports: no DTD, no
entity table beyond the five predefined names and numeric references, no
external resolution. That removes entity-expansion and external-entity attacks
by construction rather than by a configuration flag that can be turned off.
Input size, nesting depth and element count are all bounded.

The two XML parsers present in `node_modules` are transitive dependencies of
jsdom, which is a dev dependency: absent from a production install, and liable
to vanish on any lockfile change.
