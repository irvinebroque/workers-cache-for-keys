import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

	it("supports an explicit purge after an out-of-band R2 update", async () => {
		const key = `purge-${crypto.randomUUID()}.txt`;
		await env.KEY_BUCKET.put(key, "version one");

		await SELF.fetch(`https://example.com/keys/${key}`);
		await SELF.fetch(`https://example.com/keys/${key}`);
		await env.KEY_BUCKET.put(key, "version two");

		const stale = await SELF.fetch(`https://example.com/keys/${key}`);
		expect(stale.headers.get("x-cache-api-status")).toBe("HIT");
		expect(await stale.text()).toBe("version one");

		const purge = await SELF.fetch(`https://example.com/purge/${key}`, {
			method: "POST",
		});
		expect(purge.status).toBe(200);

		const refreshed = await SELF.fetch(`https://example.com/keys/${key}`);
		expect(refreshed.headers.get("x-cache-api-status")).toBe("MISS");
		expect(await refreshed.text()).toBe("version two");
	});
});
