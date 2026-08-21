# R2 caching patterns for Cloudflare Workers

This pnpm monorepo contains two Workers that serve keys from the same R2 bucket
using different cache strategies.

## Workspace layout

| App | Worker | Strategy |
| --- | --- | --- |
| `apps/workers-caching` | `workers-cache-for-keys` | Workers Caching with `max-age=30` and `stale-while-revalidate=86400` |
| `apps/cache-api` | `workers-cache-for-keys-cache-api` | Explicit Cache API reads/writes with R2-event-driven global purging |

Both Workers bind the `workers-cache-for-keys` R2 bucket as `KEY_BUCKET`.

## Comparison

| Tradeoff | Workers Caching | Cache API plus purge |
| --- | --- | --- |
| Freshness model | 30 seconds fresh, then stale content may be served for up to one day while revalidation runs | One-day TTL backed by a global purge whenever an R2 event reports a change |
| Update behavior | First request after expiry receives hot stale data and triggers a background R2 refresh | R2 emits create/delete events to a Queue; the consumer globally purges that key's `Cache-Tag` |
| Availability during refresh | Built-in stale-while-revalidate keeps serving the cached value | A globally purged key becomes a miss; the next request must read R2 before responding |
| Invalidation scope | Workers Caching supports coordinated purge controls by tag, path prefix, or everything | Immediate `cache.delete()` in the current colo plus a global purge-by-tag across all colos |
| Cache topology | Managed Workers cache with cache status and revalidation behavior | Cache API contents do not replicate and do not use tiered caching |

`caches.default.delete()` alone is insufficient because it only deletes the
entry in the data center handling that request. The Cache API Worker therefore
stores a deterministic `Cache-Tag` with every key. R2 Event Notifications send
all object creates and deletes to a Queue, whose consumer calls Cloudflare's
zone purge API with that tag. This catches changes made through the Worker,
Wrangler, the S3 API, or the dashboard.

## Why the Cache API approach is problematic

The Cache API version can provide strong freshness, but it does so by coupling
every R2 change to explicit cache invalidation:

1. The Worker must explicitly call `cache.match()` and `cache.put()`.
2. Every create, overwrite, or delete in R2 must produce an invalidation event.
3. `caches.default.delete()` only clears the current colo, so the system must
   also perform a global purge by `Cache-Tag`.
4. The application must manage the Queue, event-notification rules, API token,
   zone configuration, retries, failures, and purge batching.

Global purges are rate-limited using plan-dependent token buckets. Current
purge-by-tag limits range from 5 requests per minute on Free plans to 50
requests per second on Enterprise plans. A workload that updates many keys can
therefore exhaust its purge allowance, require careful batching, or eventually
need a higher limit.

Purging is also operationally expensive. It deliberately turns a hot cached
value into a cold miss. The next request for that key in each colo has to wait
while the Worker reads the value from R2 and puts it back into the Cache API.
That increases latency for the eyeball making the request and creates a burst
of origin traffic immediately after a deployment or a large group of updates.
Because Cache API entries do not replicate between data centers, the same cold
fill can happen independently in many colos.

The resulting lifecycle is:

```text
deploy or update
  → emit R2 events
  → consume Queue messages
  → spend purge capacity
  → evict hot cache entries globally
  → make users wait on cold R2 reads
  → explicitly repopulate each colo with cache.put()
```

This approach may still be appropriate when stale data is unacceptable, but
the developer owns substantially more code, infrastructure, failure handling,
and capacity planning.

## Why Workers Caching with stale-while-revalidate is simpler

Workers Caching reverses the tradeoff. Instead of purging on every deployment,
the application chooses a small freshness window and permits bounded staleness:

```text
Cache-Control: public, max-age=30, stale-while-revalidate=86400
```

The `max-age` is the consistency knob. It could be 10 seconds, 30 seconds, or
one minute depending on how quickly a changed key must become visible. With a
10-second value, for example, a deployment may leave the previous value visible
for roughly 10 seconds. Once the entry becomes stale, Workers Caching can serve
that cached value immediately while it fetches the new value from R2 in the
background. A subsequent request receives the refreshed value.

The important property is that a warm, resident entry remains cache-served
while revalidation runs. Users do not have to absorb a deliberate cold miss
every time a value changes, and deployments do not create a synchronized purge
and refill wave. Cold starts and cache eviction can still require an R2 read,
but normal updates do not intentionally empty the cache.

The lifecycle becomes:

```text
deploy or update
  → continue serving the warm cached value
  → reach the short max-age
  → serve stale immediately
  → refresh from R2 in the background
  → serve the new value
```

If the application can tolerate this bounded eventual consistency, the result
is a simpler architecture with fewer moving parts, no purge-rate planning, less
origin load during deployments, and consistently low latency for warm keys.
The developer declares the cache policy once rather than explicitly managing
every cache insertion and invalidation.

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
PUT    /keys/<key>   # write R2 and immediately delete the local cache entry
DELETE /keys/<key>   # delete R2 and immediately delete the local cache entry
POST   /purge/<key>  # immediate local delete plus global purge-by-tag
```

Responses include `X-Cache-API-Status: MISS|HIT`. Client-side caching is
disabled on returned responses so the example always exercises the Worker.

Each cached response has a SHA-256-derived `Cache-Tag`. The configured Queue
consumer receives R2 object-create and object-delete events, batches the
affected tags, and calls:

```text
POST /zones/<zone-id>/purge_cache
{"tags":["r2-key-..."]}
```

The mutation and purge endpoints are intentionally unauthenticated for a small
demo. Add authentication before deploying this Worker against a bucket that
contains real data.

### Global purge setup

Create the Queue before deploying the Cache API Worker:

```bash
pnpm --filter @workers-cache-for-keys/cache-api exec \
  wrangler queues create workers-cache-for-keys-r2-events
```

Configure the two values used by the zone purge API. The API token needs Cache
Purge permission for the target zone:

```bash
pnpm --filter @workers-cache-for-keys/cache-api exec \
  wrangler secret put CLOUDFLARE_ZONE_ID
pnpm --filter @workers-cache-for-keys/cache-api exec \
  wrangler secret put CLOUDFLARE_API_TOKEN
```

After deploying the Queue consumer, connect R2 create and delete events:

```bash
pnpm --filter @workers-cache-for-keys/cache-api exec \
  wrangler r2 bucket notification create workers-cache-for-keys \
  --event-type object-create \
  --queue workers-cache-for-keys-r2-events

pnpm --filter @workers-cache-for-keys/cache-api exec \
  wrangler r2 bucket notification create workers-cache-for-keys \
  --event-type object-delete \
  --queue workers-cache-for-keys-r2-events
```

The Worker should run on a route or custom domain in the zone identified by
`CLOUDFLARE_ZONE_ID`, so the cached entries and purge operation belong to the
same zone.

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
