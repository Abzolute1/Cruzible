import { describe, expect, test } from "vitest";
import {
	appendResearchArtifact,
	appendResearchArtifactFromToolResult,
	createResearchArtifactSnapshot,
	getRecentResearchArtifacts,
	RESEARCH_ARTIFACT_ENTRY_TYPE,
} from "../src/core/research-artifacts.js";

describe("research artifacts", () => {
	test("appends a research artifact snapshot off-context", () => {
		const entries: any[] = [];
		appendResearchArtifact(
			{
				appendEntry: (customType: string, data?: unknown) => {
					entries.push({ type: "custom", customType, data });
				},
			},
			{
				kind: "search",
				query: "latest React docs",
				sourceUrls: ["https://react.dev/"],
				resultCount: 1,
				compressionMode: "ultra",
			},
		);

		expect(entries).toHaveLength(1);
		expect(entries[0].customType).toBe(RESEARCH_ARTIFACT_ENTRY_TYPE);
		expect(entries[0].data).toMatchObject({
			version: 1,
			kind: "search",
			query: "latest React docs",
		});
	});

	test("restores recent research artifacts from session entries", () => {
		const search = createResearchArtifactSnapshot({
			kind: "search",
			query: "latest React docs",
			sourceUrls: ["https://react.dev/"],
			resultCount: 1,
			compressionMode: "ultra",
		});
		const fetch = createResearchArtifactSnapshot({
			kind: "fetch",
			url: "https://react.dev/",
			title: "React",
			facts: ["React builds user interfaces from components."],
			preview: "# React\nBuild user interfaces",
			contentExcerpt: "A".repeat(20_000),
			truncated: true,
		});

		const entries: any[] = [
			{ type: "custom", customType: RESEARCH_ARTIFACT_ENTRY_TYPE, data: search },
			{ type: "custom", customType: RESEARCH_ARTIFACT_ENTRY_TYPE, data: fetch },
		];
		const artifacts = getRecentResearchArtifacts(entries, 5);

		expect(artifacts).toHaveLength(2);
		expect(artifacts[1]?.url).toBe("https://react.dev/");
		expect(artifacts[1]?.facts).toEqual(["React builds user interfaces from components."]);
		expect(artifacts[1]?.contentExcerpt?.length).toBeLessThanOrEqual(12_000);
	});

	test("creates a research artifact directly from a web tool result", () => {
		const entries: any[] = [];
		const appended = appendResearchArtifactFromToolResult(
			{
				appendCustomEntry: (customType: string, data?: unknown) => {
					entries.push({ type: "custom", customType, data });
					return "c1";
				},
			},
			"webSearch",
			{
				query: "latest React docs",
				resultCount: 1,
				compressionMode: "ultra",
				results: [{ title: "React Docs", url: "https://react.dev/", snippet: "Official docs" }],
				sourceUrls: ["https://react.dev/"],
			},
		);

		expect(appended).toBe(true);
		expect(entries).toHaveLength(1);
		expect(entries[0].data).toMatchObject({
			kind: "search",
			query: "latest React docs",
			compressionMode: "ultra",
			cacheHit: false,
		});
	});

	test("creates a fetch research artifact with compact facts", () => {
		const entries: any[] = [];
		const appended = appendResearchArtifactFromToolResult(
			{
				appendCustomEntry: (customType: string, data?: unknown) => {
					entries.push({ type: "custom", customType, data });
					return "c2";
				},
			},
			"webFetch",
			{
				url: "https://react.dev/blog/2024/12/05/react-19",
				title: "React v19 – React",
				facts: ["React 19 is now stable.", "React DOM static APIs were added."],
				preview: "# React v19",
			},
		);

		expect(appended).toBe(true);
		expect(entries[0].data).toMatchObject({
			kind: "fetch",
			url: "https://react.dev/blog/2024/12/05/react-19",
			facts: ["React 19 is now stable.", "React DOM static APIs were added."],
		});
	});
});
