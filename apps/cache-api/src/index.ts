const CACHE_TTL_SECONDS = 24 * 60 * 60;
const KEY_PATH_PREFIX = "/keys/";
const PURGE_PATH_PREFIX = "/purge/";
const INTERNAL_CACHE_ORIGIN = "https://cache-api.internal/";

function decodeKey(pathname: string, prefix: string): string | null {
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

function cacheRequestForKey(key: string): Request {
	return new Request(`${INTERNAL_CACHE_ORIGIN}${encodeURIComponent(key)}`);
}

function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	headers.set("cache-control", "no-store");

	return Response.json(data, { ...init, headers });
}

function responseForClient(response: Response, cacheStatus: string): Response {
	const headers = new Headers(response.headers);
	headers.set("cache-control", "no-store");
	headers.set("x-cache-api-status", cacheStatus);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function purgeKey(key: string): Promise<boolean> {
	return caches.default.delete(cacheRequestForKey(key));
}

async function readKey(
	key: string,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	const cacheRequest = cacheRequestForKey(key);
	const cached = await caches.default.match(cacheRequest);
	if (cached !== undefined) {
		return responseForClient(cached, "HIT");
	}

	const object = await env.KEY_BUCKET.get(key);
	if (object === null) {
		return json({ error: "R2 object not found.", key }, { status: 404 });
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("cache-control", `public, max-age=${CACHE_TTL_SECONDS}`);
	headers.set("etag", object.httpEtag);
	headers.set("last-modified", object.uploaded.toUTCString());
	headers.set("x-r2-key", key);
	headers.set("x-r2-etag", object.etag);
	headers.set("x-r2-uploaded-at", object.uploaded.toISOString());
	headers.set("x-origin-fetched-at", new Date().toISOString());

	const response = new Response(object.body, { status: 200, headers });
	ctx.waitUntil(caches.default.put(cacheRequest, response.clone()));

	return responseForClient(response, "MISS");
}

async function writeKey(key: string, request: Request, env: Env): Promise<Response> {
	const contentType = request.headers.get("content-type");
	await env.KEY_BUCKET.put(key, request.body ?? new Uint8Array(), {
		httpMetadata: contentType === null ? undefined : { contentType },
	});

	const purged = await purgeKey(key);
	return json({
		key,
		updated: true,
		purge: {
			api: "caches.default.delete",
			deletedFromCurrentDataCenter: purged,
		},
	});
}

async function deleteKey(key: string, env: Env): Promise<Response> {
	await env.KEY_BUCKET.delete(key);
	const purged = await purgeKey(key);

	return json({
		key,
		deleted: true,
		purge: {
			api: "caches.default.delete",
			deletedFromCurrentDataCenter: purged,
		},
	});
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			return json({
				message: "Explicit Cache API example backed by R2",
				read: `GET ${url.origin}/keys/<key>`,
				writeAndPurge: `PUT ${url.origin}/keys/<key>`,
				deleteAndPurge: `DELETE ${url.origin}/keys/<key>`,
				purgeOnly: `POST ${url.origin}/purge/<key>`,
				cacheTtlSeconds: CACHE_TTL_SECONDS,
			});
		}

		const key = decodeKey(url.pathname, KEY_PATH_PREFIX);
		if (key !== null) {
			switch (request.method) {
				case "GET":
					return readKey(key, env, ctx);
				case "PUT":
					return writeKey(key, request, env);
				case "DELETE":
					return deleteKey(key, env);
				default:
					return json(
						{ error: "Use GET, PUT, or DELETE for /keys/<key>." },
						{ status: 405, headers: { allow: "GET, PUT, DELETE" } },
					);
			}
		}

		const purgeKeyName = decodeKey(url.pathname, PURGE_PATH_PREFIX);
		if (purgeKeyName !== null && request.method === "POST") {
			const purged = await purgeKey(purgeKeyName);
			return json({
				key: purgeKeyName,
				purged: true,
				deletedFromCurrentDataCenter: purged,
			});
		}

		return json({ error: "Not found." }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
