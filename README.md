# R2 caching patterns for Cloudflare Workers

This pnpm monorepo contains two Workers that serve keys from the same R2 bucket
using different cache strategies.

## Workspace layout

| App | Worker | Strategy |
| --- | --- | --- |
| `apps/workers-caching` | `workers-cache-for-keys` | Workers Caching with `max-age=30` and `stale-while-revalidate=86400` |
| `apps/cache-api` | `workers-cache-for-keys-cache-api` | Explicit `caches.default.match()`, `cache.put()`, and `cache.delete()` |

Both Workers bind the `workers-cache-for-keys` R2 bucket as `KEY_BUCKET`.

## Comparison

| Tradeoff | Workers Caching | Cache API plus purge |
| --- | --- | --- |
| Freshness model | 30 seconds fresh, then stale content may be served for up to one day while revalidation runs | One-day TTL; correctness depends on purging whenever R2 changes |
| Update behavior | First request after expiry receives hot stale data and triggers a background R2 refresh | `PUT` and `DELETE` update R2 and immediately call `caches.default.delete()` |
| Availability during refresh | Built-in stale-while-revalidate keeps serving the cached value | A purged key becomes a miss; the next request must read R2 before responding |
| Invalidation scope | Workers Caching supports coordinated purge controls by tag, path prefix, or everything | `cache.delete()` only deletes the entry in the data center handling that request |
| Cache topology | Managed Workers cache with cache status and revalidation behavior | Cache API contents do not replicate and do not use tiered caching |

The Cache API example deliberately makes its limitation visible: updating R2
directly does not invalidate the cached copy. Call `POST /purge/<key>` after an
out-of-band update. That endpoint uses `caches.default.delete()`, so it is a
local-data-center purge rather than a globally coordinated purge.

## Workers Caching app

The public entry point calls the exported `R2Origin` entry point through
`ctx.exports`. The public entry point is opted out of caching; only `R2Origin`
is cache-enabled, avoiding two stacked cache windows.

```text
GET /keys/<URL-encoded-R2-key>
```

The origin response uses:

```text
Cache-Control: public, max-age=30, stale-while-revalidate=86400
```

Observed deployed behavior:

```text
MISS → HIT → UPDATING at age 30 → HIT with the new R2 value
```

In the verification run, an overwritten R2 value became visible 29 seconds
after the update.

## Cache API app

```text
GET    /keys/<key>   # match cache; on miss read R2 and cache.put()
PUT    /keys/<key>   # write R2, then cache.delete()
DELETE /keys/<key>   # delete R2, then cache.delete()
POST   /purge/<key>  # cache.delete() without changing R2
```

Responses include `X-Cache-API-Status: MISS|HIT`. Client-side caching is
disabled on returned responses so the example always exercises the Worker.

The mutation and purge endpoints are intentionally unauthenticated for a small
demo. Add authentication before deploying this Worker against a bucket that
contains real data.

## Commands

```bash
pnpm install
pnpm check
pnpm test
pnpm typecheck
pnpm cf-typegen

pnpm deploy:workers-caching
pnpm deploy:cache-api
```

Run one app locally:

```bash
pnpm --filter @workers-cache-for-keys/workers-caching dev
pnpm --filter @workers-cache-for-keys/cache-api dev
```

Seed a remote R2 object:

```bash
printf 'version one\n' > /tmp/demo.txt
pnpm --filter @workers-cache-for-keys/workers-caching exec \
  wrangler r2 object put workers-cache-for-keys/demo.txt \
  --remote --file /tmp/demo.txt --content-type text/plain
```
