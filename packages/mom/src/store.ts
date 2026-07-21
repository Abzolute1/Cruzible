import { existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

export interface Attachment {
	original: string; // original filename from uploader
	local: string; // path relative to working dir (e.g., "C12345/attachments/1732531234567_file.png")
}

export interface ChannelStoreConfig {
	workingDir: string;
	botToken: string; // needed for authenticated file downloads
}

interface PendingDownload {
	channelId: string;
	localPath: string; // relative path
	url: string;
	resolve: () => void; // called when this download finishes (success or failure)
}

// Cap attachment downloads so a multi-GB file can't OOM the bot
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export class ChannelStore {
	private workingDir: string;
	private botToken: string;
	private pendingDownloads: PendingDownload[] = [];
	private isDownloading = false;
	// In-flight downloads by local path, so runs can wait for their attachments
	private inFlightDownloads = new Map<string, Promise<void>>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;

		// Ensure working directory exists
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * Get or create the directory for a channel/DM
	 */
	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	/**
	 * Generate a unique local filename for an attachment
	 */
	generateLocalFilename(originalName: string, timestamp: string): string {
		// Convert slack timestamp (1234567890.123456) to milliseconds
		const ts = Math.floor(parseFloat(timestamp) * 1000);
		// Sanitize original name (remove problematic characters)
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	/**
	 * Process attachments from a Slack message event
	 * Returns attachment metadata and queues downloads
	 */
	processAttachments(
		channelId: string,
		files: Array<{ name?: string; url_private_download?: string; url_private?: string }>,
		timestamp: string,
	): Attachment[] {
		const attachments: Attachment[] = [];

		for (const file of files) {
			const url = file.url_private_download || file.url_private;
			if (!url) continue;
			if (!file.name) {
				log.logWarning("Attachment missing name, skipping", url);
				continue;
			}

			const filename = this.generateLocalFilename(file.name, timestamp);
			const localPath = `${channelId}/attachments/${filename}`;

			attachments.push({
				original: file.name,
				local: localPath,
			});

			// Queue for background download
			const done = new Promise<void>((resolve) => {
				this.pendingDownloads.push({ channelId, localPath, url, resolve });
			});
			this.inFlightDownloads.set(localPath, done);
		}

		// Trigger background download
		this.processDownloadQueue();

		return attachments;
	}

	/**
	 * Wait for the given attachments' downloads to finish (success or failure).
	 * Call before starting a run so the agent never reads paths that don't exist yet.
	 */
	async waitForDownloads(localPaths: string[]): Promise<void> {
		await Promise.all(localPaths.map((p) => this.inFlightDownloads.get(p)).filter((p) => p !== undefined));
	}

	/**
	 * Process the download queue in the background
	 */
	private async processDownloadQueue(): Promise<void> {
		if (this.isDownloading || this.pendingDownloads.length === 0) return;

		this.isDownloading = true;

		while (this.pendingDownloads.length > 0) {
			const item = this.pendingDownloads.shift();
			if (!item) break;

			try {
				await this.downloadAttachment(item.localPath, item.url);
				// Success - could add success logging here if we have context
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				log.logWarning(`Failed to download attachment`, `${item.localPath}: ${errorMsg}`);
			} finally {
				this.inFlightDownloads.delete(item.localPath);
				item.resolve();
			}
		}

		this.isDownloading = false;
	}

	/**
	 * Download a single attachment
	 */
	private async downloadAttachment(localPath: string, url: string): Promise<void> {
		const filePath = join(this.workingDir, localPath);

		// Ensure directory exists
		const dir = join(this.workingDir, localPath.substring(0, localPath.lastIndexOf("/")));
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

		try {
			const response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${this.botToken}`,
				},
				signal: controller.signal,
			});

			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}

			// Reject early when the server tells us the size
			const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
			if (contentLength > MAX_ATTACHMENT_BYTES) {
				throw new Error(`Attachment too large: ${contentLength} bytes (limit ${MAX_ATTACHMENT_BYTES})`);
			}

			// Stream with a hard cap - a missing/lying Content-Length can't OOM us
			if (!response.body) {
				throw new Error("Empty response body");
			}
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > MAX_ATTACHMENT_BYTES) {
					await reader.cancel();
					throw new Error(`Attachment exceeds ${MAX_ATTACHMENT_BYTES} byte limit`);
				}
				chunks.push(value);
			}

			await writeFile(filePath, Buffer.concat(chunks.map((c) => Buffer.from(c))));
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}
}
