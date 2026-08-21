import { WorkerEntrypoint } from "cloudflare:workers";

const EDGE_MAX_AGE_SECONDS = 30;
const STALE_WHILE_REVALIDATE_SECONDS = 24 * 60 * 60;
const KEY_PATH_PREFIX = "/keys/";
const REFRESH_PATH_PREFIX = "/refresh/";
const DEMO_KEY_PATH_PREFIX = "/demo/keys/";
const CACHE_KEY_ORIGIN = "https://r2-origin.internal";
const DEMO_KEY_PATTERN = /^browser-demo\/[a-z0-9-]{1,80}\.txt$/;
const MAX_DEMO_VALUE_BYTES = 1024;

function keyFromPath(pathname: string, prefix: string): string | null {
	if (!pathname.startsWith(prefix)) {
		return null;
	}

	const encodedKey = pathname.slice(prefix.length);
	if (encodedKey.length === 0) {
		return null;
	}

	try {
		return decodeURIComponent(encodedKey);
	} catch {
		return null;
	}
}

function keyFromRequest(request: Request): string | null {
	return keyFromPath(new URL(request.url).pathname, KEY_PATH_PREFIX);
}

function cacheRequestForKey(key: string, method = "GET"): Request {
	return new Request(
		`${CACHE_KEY_ORIGIN}${KEY_PATH_PREFIX}${encodeURIComponent(key)}`,
		{ method },
	);
}

async function readLimitedText(
	request: Request,
	maxBytes: number,
): Promise<string> {
	if (request.body === null) {
		return "";
	}

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error("BODY_TOO_LARGE");
		}
		chunks.push(value);
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return new TextDecoder().decode(body);
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
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api") {
			return json({
				message: "Fetch an R2 object at /keys/<key>",
				example: `${url.origin}/keys/demo.txt`,
				triggerRefresh: `POST ${url.origin}/refresh/demo.txt`,
				edgeCache: {
					maxAgeSeconds: EDGE_MAX_AGE_SECONDS,
					staleWhileRevalidateSeconds: STALE_WHILE_REVALIDATE_SECONDS,
				},
			});
		}

		const demoKey = keyFromPath(url.pathname, DEMO_KEY_PATH_PREFIX);
		if (demoKey !== null) {
			if (!DEMO_KEY_PATTERN.test(demoKey)) {
				return json(
					{ error: "Browser demo keys must use browser-demo/<id>.txt." },
					{ status: 400 },
				);
			}

			if (request.method === "PUT") {
				try {
					const value = await readLimitedText(
						request,
						MAX_DEMO_VALUE_BYTES,
					);
					const object = await env.KEY_BUCKET.put(demoKey, value, {
						httpMetadata: {
							contentType: "text/plain; charset=utf-8",
						},
					});

					return json({
						key: demoKey,
						updated: true,
						etag: object.etag,
						uploadedAt: object.uploaded.toISOString(),
					});
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "BODY_TOO_LARGE"
					) {
						return json(
							{ error: `Demo values are limited to ${MAX_DEMO_VALUE_BYTES} bytes.` },
							{ status: 413 },
						);
					}
					throw error;
				}
			}

			if (request.method === "DELETE") {
				await env.KEY_BUCKET.delete(demoKey);
				return json({ key: demoKey, deleted: true });
			}

			return json(
				{ error: "Use PUT or DELETE for /demo/keys/<key>." },
				{ status: 405, headers: { allow: "PUT, DELETE" } },
			);
		}

		const refreshKey = keyFromPath(url.pathname, REFRESH_PATH_PREFIX);
		if (refreshKey !== null && request.method === "POST") {
			// This request intentionally targets the exact same cache key used by
			// readers. Assuming the entry is stale, Workers Caching serves the
			// stale response here and refreshes it from R2 in the background.
			const staleResponse = await ctx.exports.R2Origin.fetch(
				cacheRequestForKey(refreshKey),
			);
			const result = {
				key: refreshKey,
				refreshTriggered: staleResponse.ok,
				cacheStatus: staleResponse.headers.get("cf-cache-status"),
				servedEtag: staleResponse.headers.get("etag"),
				servedOriginFetch: staleResponse.headers.get(
					"x-origin-fetched-at",
				),
			};
			await staleResponse.body?.cancel();

			return json(result, {
				status: staleResponse.ok ? 202 : staleResponse.status,
			});
		}

		if (request.method !== "GET" && request.method !== "HEAD") {
			return json(
				{ error: "Use GET or HEAD for /keys/<key>, or POST /refresh/<key>." },
				{ status: 405, headers: { allow: "GET, HEAD, POST" } },
			);
		}

		const key = keyFromRequest(request);
		if (key === null) {
			return json(
				{ error: "Use /keys/<key> with a non-empty, URL-encoded R2 key." },
				{ status: 404 },
			);
		}

		return ctx.exports.R2Origin.fetch(
			cacheRequestForKey(key, request.method),
		);
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
