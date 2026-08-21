import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { cacheTagForKey, purgeTagsGlobally } from "../src";

describe("Cache API R2 Worker", () => {
	it("documents its read, write, and purge endpoints", async () => {
		const response = await SELF.fetch("https://example.com/");

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.json()).resolves.toMatchObject({
			cacheTtlSeconds: 86_400,
		});
	});

	it("explicitly puts an R2 object into caches.default", async () => {
		const key = `cache-${crypto.randomUUID()}.txt`;
		await env.KEY_BUCKET.put(key, "version one");

		const miss = await SELF.fetch(`https://example.com/keys/${key}`);
		expect(miss.headers.get("x-cache-api-status")).toBe("MISS");
		expect(await miss.text()).toBe("version one");

		const hit = await SELF.fetch(`https://example.com/keys/${key}`);
		expect(hit.headers.get("x-cache-api-status")).toBe("HIT");
		expect(await hit.text()).toBe("version one");
	});

	it("purges the cached value whenever PUT changes R2", async () => {
		const key = `update-${crypto.randomUUID()}.txt`;
		await env.KEY_BUCKET.put(key, "version one");

		await SELF.fetch(`https://example.com/keys/${key}`);
		const warm = await SELF.fetch(`https://example.com/keys/${key}`);
		expect(warm.headers.get("x-cache-api-status")).toBe("HIT");

		const update = await SELF.fetch(`https://example.com/keys/${key}`, {
			method: "PUT",
			headers: { "content-type": "text/plain; charset=utf-8" },
			body: "version two",
		});
		expect(update.status).toBe(200);

		const refreshed = await SELF.fetch(`https://example.com/keys/${key}`);
		expect(refreshed.headers.get("x-cache-api-status")).toBe("MISS");
		expect(await refreshed.text()).toBe("version two");
	});

	it("keeps an out-of-band R2 update stale until a global purge occurs", async () => {
		const key = `purge-${crypto.randomUUID()}.txt`;
		await env.KEY_BUCKET.put(key, "version one");

		await SELF.fetch(`https://example.com/keys/${key}`);
		await SELF.fetch(`https://example.com/keys/${key}`);
		await env.KEY_BUCKET.put(key, "version two");

		const stale = await SELF.fetch(`https://example.com/keys/${key}`);
		expect(stale.headers.get("x-cache-api-status")).toBe("HIT");
		expect(await stale.text()).toBe("version one");
	});

	it("purges deterministic per-key cache tags through the zone API", async () => {
		const tag = await cacheTagForKey("folder/demo.txt");
		expect(tag).toMatch(/^r2-key-[a-f0-9]{64}$/);

		const requests: Request[] = [];
		await purgeTagsGlobally(
			[tag],
			{ zoneId: "test-zone", apiToken: "test-token" },
			async (input, init) => {
				const request = new Request(input, init);
				requests.push(request);
				return Response.json({ success: true });
			},
		);

		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe(
			"https://api.cloudflare.com/client/v4/zones/test-zone/purge_cache",
		);
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer test-token",
		);
		await expect(requests[0].json()).resolves.toEqual({ tags: [tag] });
	});
});
