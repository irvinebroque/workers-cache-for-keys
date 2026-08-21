const FRESH_SECONDS = 30;
const VERSION_ONE = "version one";
const VERSION_TWO = "version two";

const elements = {
	run: document.querySelector("#run-demo"),
	reset: document.querySelector("#reset-demo"),
	status: document.querySelector("#run-status"),
	key: document.querySelector("#demo-key"),
	r2Value: document.querySelector("#r2-value"),
	r2Meta: document.querySelector("#r2-meta"),
	cacheValue: document.querySelector("#cache-value"),
	cacheMeta: document.querySelector("#cache-meta"),
	browserValue: document.querySelector("#browser-value"),
	browserMeta: document.querySelector("#browser-meta"),
	countdownLabel: document.querySelector("#countdown-label"),
	countdownValue: document.querySelector("#countdown-value"),
	progress: document.querySelector("#progress-bar"),
	emptyTimeline: document.querySelector("#empty-timeline"),
	timeline: document.querySelector("#timeline"),
};

let demoKey = createDemoKey();
let running = false;
let startedAt = 0;

function createDemoKey() {
	return `browser-demo/${crypto.randomUUID()}.txt`;
}

function encodedKey() {
	return encodeURIComponent(demoKey);
}

function setStatus(label, state) {
	elements.status.textContent = label;
	elements.status.dataset.state = state;
}

function setDemoKey(key) {
	demoKey = key;
	elements.key.textContent = key;
}

function shortEtag(etag) {
	if (!etag) return "—";
	return etag.replaceAll('"', "").slice(0, 10);
}

function elapsed() {
	if (!startedAt) return "0.0s";
	return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

function addTimeline({ action, status = "INFO", result = "" }) {
	elements.emptyTimeline.hidden = true;
	const normalized = status.toLowerCase();
	const entry = document.createElement("div");
	entry.className = "timeline-entry";

	const time = document.createElement("span");
	time.className = "timeline-time";
	time.textContent = elapsed();

	const actionElement = document.createElement("span");
	actionElement.className = "timeline-action";
	actionElement.textContent = action;

	const badge = document.createElement("span");
	badge.className = `cache-badge ${normalized}`;
	badge.textContent = status;

	const resultElement = document.createElement("span");
	resultElement.className = "timeline-result";
	resultElement.textContent = result;

	entry.append(time, actionElement, badge, resultElement);
	elements.timeline.append(entry);
	entry.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function writeR2(value) {
	const response = await fetch(`/demo/keys/${encodedKey()}`, {
		method: "PUT",
		headers: { "content-type": "text/plain; charset=utf-8" },
		body: value,
	});
	if (!response.ok) throw new Error(await response.text());
	const result = await response.json();

	elements.r2Value.textContent = value;
	elements.r2Meta.textContent = `ETag ${shortEtag(result.etag)}`;
	addTimeline({
		action: `Write “${value}” to R2`,
		status: "WRITE",
		result: `etag ${shortEtag(result.etag)}`,
	});
	return result;
}

async function readKey(label) {
	const response = await fetch(
		`/keys/${encodedKey()}?browser-request=${Date.now()}`,
	);
	if (!response.ok) throw new Error(await response.text());

	const value = await response.text();
	const cacheStatus = response.headers.get("cf-cache-status") ?? "LOCAL";
	const age = response.headers.get("age");
	const etag = response.headers.get("etag");
	const originFetch = response.headers.get("x-origin-fetched-at");

	elements.browserValue.textContent = value;
	elements.browserMeta.textContent =
		cacheStatus === "LOCAL"
			? "Local runtime: edge cache is not emulated"
			: `${cacheStatus}${age ? ` · age ${age}s` : ""}`;
	elements.cacheValue.textContent = value;
	elements.cacheMeta.textContent = `${cacheStatus}${age ? ` · age ${age}s` : ""} · etag ${shortEtag(etag)}`;

	addTimeline({
		action: label,
		status: cacheStatus,
		result: `${value} · origin ${originFetch?.slice(11, 23) ?? "—"}`,
	});

	return { value, cacheStatus, etag, originFetch };
}

async function triggerRefresh() {
	const response = await fetch(`/refresh/${encodedKey()}`, { method: "POST" });
	if (!response.ok) throw new Error(await response.text());
	const result = await response.json();

	addTimeline({
		action: "Deployment hook requests refresh",
		status: result.cacheStatus ?? "UPDATING",
		result: `served stale etag ${shortEtag(result.servedEtag)}`,
	});
	elements.cacheMeta.textContent = "Serving stale · refreshing from R2";
	return result;
}

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForStale() {
	elements.countdownLabel.textContent = "Waiting for the cached value to become stale";

	for (let remaining = FRESH_SECONDS; remaining >= 0; remaining -= 1) {
		elements.countdownValue.textContent = `${remaining}s`;
		elements.progress.style.width = `${((FRESH_SECONDS - remaining) / FRESH_SECONDS) * 100}%`;
		if (remaining > 0) await sleep(1000);
	}

	await sleep(750);
	elements.countdownLabel.textContent = "Cache entry is stale";
	elements.countdownValue.textContent = "ready";
}

async function waitForVersionTwo() {
	elements.countdownLabel.textContent = "Background refresh in progress";
	elements.countdownValue.textContent = "…";

	for (let attempt = 1; attempt <= 12; attempt += 1) {
		await sleep(700);
		const result = await readKey(`Reader check ${attempt}`);
		if (result.value === VERSION_TWO) {
			elements.countdownLabel.textContent = "Fresh value is warm";
			elements.countdownValue.textContent = "done";
			elements.progress.style.width = "100%";
			return;
		}
	}

	throw new Error("The refreshed value did not become visible in time.");
}

async function cleanup() {
	try {
		await fetch(`/demo/keys/${encodedKey()}`, { method: "DELETE" });
	} catch {
		// Cleanup is best effort for an isolated demo key.
	}
}

function resetUi() {
	elements.timeline.replaceChildren();
	elements.emptyTimeline.hidden = false;
	elements.r2Value.textContent = "Not written";
	elements.r2Meta.textContent = "Waiting for the demo";
	elements.cacheValue.textContent = "Empty";
	elements.cacheMeta.textContent = "No request yet";
	elements.browserValue.textContent = "Nothing yet";
	elements.browserMeta.textContent = "Waiting for a request";
	elements.countdownLabel.textContent = "Freshness window";
	elements.countdownValue.textContent = `${FRESH_SECONDS}s`;
	elements.progress.style.width = "0";
	setStatus("Ready", "idle");
}

async function runDemo() {
	if (running) return;
	running = true;
	startedAt = performance.now();
	elements.run.disabled = true;
	elements.reset.disabled = true;
	setStatus("Running", "running");

	try {
		await writeR2(VERSION_ONE);
		await readKey("First reader request");
		await sleep(900);
		await readKey("Second reader request");
		await waitForStale();
		await writeR2(VERSION_TWO);
		await triggerRefresh();
		await waitForVersionTwo();
		setStatus("Fresh + warm", "success");
		addTimeline({
			action: "Demo complete",
			status: "HIT",
			result: "version two is now warm",
		});
	} catch (error) {
		console.error(error);
		setStatus("Demo failed", "error");
		addTimeline({
			action: "Demo stopped",
			status: "INFO",
			result: error instanceof Error ? error.message : String(error),
		});
	} finally {
		running = false;
		elements.run.disabled = false;
		elements.reset.disabled = false;
	}
}

elements.run.addEventListener("click", runDemo);
elements.reset.addEventListener("click", async () => {
	if (running) return;
	await cleanup();
	setDemoKey(createDemoKey());
	startedAt = 0;
	resetUi();
});

setDemoKey(demoKey);
