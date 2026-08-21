import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("R2 key cache Worker", () => {
	it("returns usage information at the root", async () => {
		const response = await SELF.fetch("https://example.com/api");

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.json()).resolves.toMatchObject({
			edgeCache: {
				maxAgeSeconds: 30,
				staleWhileRevalidateSeconds: 86_400,
			},
		});
	});

	it("lets the browser demo write and clean up isolated R2 keys", async () => {
		const key = `browser-demo/${crypto.randomUUID()}.txt`;
		const encodedKey = encodeURIComponent(key);

		const update = await SELF.fetch(
			`https://example.com/demo/keys/${encodedKey}`,
			{ method: "PUT", body: "browser version one" },
		);
		expect(update.status).toBe(200);

		const object = await env.KEY_BUCKET.get(key);
		expect(await object?.text()).toBe("browser version one");

		const cleanup = await SELF.fetch(
			`https://example.com/demo/keys/${encodedKey}`,
			{ method: "DELETE" },
		);
		expect(cleanup.status).toBe(200);
		expect(await env.KEY_BUCKET.get(key)).toBeNull();
	});

	it("serves an object from the bound R2 bucket", async () => {
		const key = `test-${crypto.randomUUID()}.txt`;
		await env.KEY_BUCKET.put(key, "value from R2", {
			httpMetadata: { contentType: "text/plain; charset=utf-8" },
		});

		const response = await SELF.fetch(`https://example.com/keys/${key}`);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"text/plain; charset=utf-8",
		);
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=30, stale-while-revalidate=86400",
		);
		expect(response.headers.get("x-r2-key")).toBe(key);
		expect(await response.text()).toBe("value from R2");
	});

	it("does not cache missing objects", async () => {
		const key = `missing-${crypto.randomUUID()}.txt`;
		const response = await SELF.fetch(`https://example.com/keys/${key}`);

		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
		await expect(response.json()).resolves.toEqual({
			error: "R2 object not found.",
			key,
		});
	});

	it("can proactively trigger revalidation for the reader cache key", async () => {
		const key = `refresh-${crypto.randomUUID()}.txt`;
		await env.KEY_BUCKET.put(key, "updated value");

		const response = await SELF.fetch(
			`https://example.com/refresh/${encodeURIComponent(key)}`,
			{ method: "POST" },
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			key,
			refreshTriggered: true,
		});
	});
});
