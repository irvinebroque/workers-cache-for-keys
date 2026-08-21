import { WorkerEntrypoint } from "cloudflare:workers";

const EDGE_MAX_AGE_SECONDS = 30;
const STALE_WHILE_REVALIDATE_SECONDS = 24 * 60 * 60;
const KEY_PATH_PREFIX = "/keys/";

function keyFromRequest(request: Request): string | null {
	const pathname = new URL(request.url).pathname;
	if (!pathname.startsWith(KEY_PATH_PREFIX)) {
		return null;
	}

	const encodedKey = pathname.slice(KEY_PATH_PREFIX.length);
	if (encodedKey.length === 0) {
		return null;
	}

	try {
		return decodeURIComponent(encodedKey);
	} catch {
		return null;
	}
}

function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.set("cache-control", "no-store");

	return Response.json(data, { ...init, headers });
}

/**
 * Public entry point.
 *
 * Calling the exported R2Origin entry point through ctx.exports enables
 * Workers Caching. The cache key includes the entry point and request URL.
 */
export default {
	async fetch(request, _env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			return json({
				message: "Fetch an R2 object at /keys/<key>",
				example: `${url.origin}/keys/demo.txt`,
				edgeCache: {
					maxAgeSeconds: EDGE_MAX_AGE_SECONDS,
					staleWhileRevalidateSeconds: STALE_WHILE_REVALIDATE_SECONDS,
				},
			});
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return json(
				{ error: "Only GET and HEAD are supported." },
				{ status: 405, headers: { allow: "GET, HEAD" } },
			);
		}

		const key = keyFromRequest(request);
		if (key === null) {
			return json(
				{ error: "Use /keys/<key> with a non-empty, URL-encoded R2 key." },
				{ status: 404 },
			);
		}

		// Ignore query parameters so diagnostics do not accidentally fragment the
		// cache. The R2 key is entirely represented by the path.
		const cacheUrl = new URL(request.url);
		cacheUrl.search = "";
		const cacheRequest = new Request(cacheUrl, request);

		return ctx.exports.R2Origin.fetch(cacheRequest);
	},
} satisfies ExportedHandler<Env>;

/**
 * Cacheable R2 origin entry point.
 *
 * Workers Caching stores this entry point's successful responses. Once a
 * response is 30 seconds old, the next request may receive the stale response
 * immediately while Cloudflare refreshes it in the background from R2.
 */
export class R2Origin extends WorkerEntrypoint<Env> {
	async fetch(request: Request): Promise<Response> {
		const key = keyFromRequest(request);
		if (key === null) {
			return json({ error: "Invalid R2 key." }, { status: 400 });
		}

		const object = await this.env.KEY_BUCKET.get(key);
		if (object === null) {
			// Do not cache misses, so a newly-created object is visible immediately.
			return json({ error: "R2 object not found.", key }, { status: 404 });
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set("etag", object.httpEtag);
		headers.set("last-modified", object.uploaded.toUTCString());
		headers.set("x-r2-key", key);
		headers.set("x-r2-etag", object.etag);
		headers.set("x-r2-uploaded-at", object.uploaded.toISOString());
		headers.set("x-origin-fetched-at", new Date().toISOString());

		headers.set(
			"cache-control",
			`public, max-age=${EDGE_MAX_AGE_SECONDS}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
		);

		return new Response(request.method === "HEAD" ? null : object.body, {
			status: 200,
			headers,
		});
	}
}
