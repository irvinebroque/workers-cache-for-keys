const CACHE_TTL_SECONDS = 24 * 60 * 60;
const KEY_PATH_PREFIX = "/keys/";
const PURGE_PATH_PREFIX = "/purge/";
const INTERNAL_CACHE_ORIGIN = "https://cache-api.internal/";

type AppEnv = Env & {
	CLOUDFLARE_ZONE_ID: string;
	CLOUDFLARE_API_TOKEN: string;
};

type PurgeFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

interface R2EventNotification {
	account: string;
	action: string;
	bucket: string;
	object: {
		key: string;
		size?: number;
		eTag?: string;
	};
	eventTime: string;
}

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
	headers.delete("cache-tag");
	headers.set("cache-control", "no-store");
	headers.set("x-cache-api-status", cacheStatus);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

async function purgeKeyLocally(key: string): Promise<boolean> {
	return caches.default.delete(cacheRequestForKey(key));
}

export async function cacheTagForKey(key: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(key),
	);
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");

	return `r2-key-${hash}`;
}

export async function purgeTagsGlobally(
	tags: string[],
	config: { zoneId: string; apiToken: string },
	fetcher: PurgeFetch = fetch,
): Promise<void> {
	if (tags.length === 0) {
		return;
	}

	const response = await fetcher(
		`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(config.zoneId)}/purge_cache`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${config.apiToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ tags }),
		},
	);

	const result: { success?: boolean } = await response.json();
	if (!response.ok || result.success !== true) {
		throw new Error(`Global cache purge failed with status ${response.status}.`);
	}
}

async function readKey(
	key: string,
	env: AppEnv,
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
	headers.set("cache-tag", await cacheTagForKey(key));
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

async function writeKey(
	key: string,
	request: Request,
	env: AppEnv,
): Promise<Response> {
	const contentType = request.headers.get("content-type");
	await env.KEY_BUCKET.put(key, request.body ?? new Uint8Array(), {
		httpMetadata: contentType === null ? undefined : { contentType },
	});

	const purgedLocally = await purgeKeyLocally(key);
	return json({
		key,
		updated: true,
		purge: {
			local: {
				api: "caches.default.delete",
				deletedFromCurrentDataCenter: purgedLocally,
			},
			global: "scheduled by the R2 event notification",
		},
	});
}

async function deleteKey(key: string, env: AppEnv): Promise<Response> {
	await env.KEY_BUCKET.delete(key);
	const purgedLocally = await purgeKeyLocally(key);

	return json({
		key,
		deleted: true,
		purge: {
			local: {
				api: "caches.default.delete",
				deletedFromCurrentDataCenter: purgedLocally,
			},
			global: "scheduled by the R2 event notification",
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
				globalPurgeOnly: `POST ${url.origin}/purge/<key>`,
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
			const deletedLocally = await purgeKeyLocally(purgeKeyName);
			const tag = await cacheTagForKey(purgeKeyName);
			await purgeTagsGlobally([tag], {
				zoneId: env.CLOUDFLARE_ZONE_ID,
				apiToken: env.CLOUDFLARE_API_TOKEN,
			});

			return json({
				key: purgeKeyName,
				purged: true,
				tag,
				deletedFromCurrentDataCenter: deletedLocally,
				purgedGlobally: true,
			});
		}

		return json({ error: "Not found." }, { status: 404 });
	},

	async queue(batch, env): Promise<void> {
		const keys = [
			...new Set(
				batch.messages
					.map((message) => message.body)
					.filter((event) => event.bucket === "workers-cache-for-keys")
					.map((event) => event.object.key),
			),
		];
		const tags = await Promise.all(keys.map(cacheTagForKey));

		await purgeTagsGlobally(tags, {
			zoneId: env.CLOUDFLARE_ZONE_ID,
			apiToken: env.CLOUDFLARE_API_TOKEN,
		});

		console.log(
			JSON.stringify({
				event: "r2-cache-tags-purged",
				keyCount: keys.length,
				tagCount: tags.length,
			}),
		);
	},
} satisfies ExportedHandler<AppEnv, R2EventNotification>;
