# R2 keys served through Workers Caching

This Worker exposes objects from an R2 bucket at:

```text
GET /keys/<URL-encoded-R2-key>
```

It has two Worker entry points:

1. The default public `fetch` handler calls `ctx.exports.R2Origin`.
2. `R2Origin` reads the object from the `KEY_BUCKET` R2 binding.

The public entry point is explicitly opted out of caching so it always runs as
the gateway. Only the `R2Origin` loopback entry point is cache-enabled; this
avoids stacking two independent 30-second stale-while-revalidate windows.
Successful object responses use:

```text
max-age=30, stale-while-revalidate=86400
```

For the first 30 seconds, requests are served from the fresh edge cache. After
that, the next request can be served immediately from the stale cache while
Cloudflare refreshes the value from R2 in the background. A subsequent request
then receives the refreshed object.

The response exposes `X-Origin-Fetched-At`, `X-R2-ETag`, and
`X-R2-Uploaded-At` headers so the refresh is easy to observe. Workers Caching
consumes the origin cache policy and returns `Cache-Control: no-store` to the
client. Use `curl` to watch `CF-Cache-Status` change from `MISS` to `HIT` and
then `UPDATING`.

## Commands

```bash
npm test
npm run cf-typegen
npx wrangler r2 bucket create workers-cache-for-keys
npx wrangler r2 object put workers-cache-for-keys/demo.txt --remote --file ./demo.txt
npm run deploy
```

## Update demonstration

Request the object repeatedly, overwrite `demo.txt` in R2, and continue
requesting it. The old value remains hot during the 30-second fresh period. The
first request after expiry can receive stale content while triggering
background revalidation; the next request receives the new R2 value.

This is request-driven revalidation. If no request arrives after the 30-second
fresh period, no background refresh is started until one does.

Workers Caching behavior must be verified after deployment; the local Workers
runtime currently invokes the loopback entry point but does not emulate its
edge cache.
