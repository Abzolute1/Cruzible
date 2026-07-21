import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { webFetchToolDefinition } from "../src/core/tools/webfetch.js";

async function fetchText(url: string): Promise<string> {
	const result = await webFetchToolDefinition.execute(
		"test",
		{ url },
		undefined,
		undefined,
		{} as unknown as ExtensionContext,
	);
	const first = result.content[0] as { type: string; text?: string };
	return first.text ?? "";
}

describe("webFetch SSRF protection", () => {
	it("blocks IPv4-mapped IPv6 loopback in dotted form", async () => {
		const text = await fetchText("http://[::ffff:127.0.0.1]/");
		expect(text).toContain("private/internal");
	});

	it("blocks IPv4-mapped IPv6 loopback in hex form", async () => {
		const text = await fetchText("http://[::ffff:7f00:1]/");
		expect(text).toContain("private/internal");
	});

	it("blocks IPv4-mapped IPv6 private ranges", async () => {
		expect(await fetchText("http://[::ffff:10.1.2.3]/")).toContain("private/internal");
		expect(await fetchText("http://[::ffff:ac10:1]/")).toContain("private/internal"); // 172.16.0.1
		expect(await fetchText("http://[::ffff:192.168.0.1]/")).toContain("private/internal");
	});

	it("still blocks plain loopback and IPv6 loopback", async () => {
		expect(await fetchText("http://127.0.0.1/")).toContain("private/internal");
		expect(await fetchText("http://[::1]/")).toContain("private/internal");
	});
});
