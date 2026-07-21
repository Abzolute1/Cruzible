import { randomBytes } from "node:crypto";
import { chmod, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

function abortError(): Error {
	return new Error("Operation aborted");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw abortError();
	}
}

async function getExistingMode(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch {
		return undefined;
	}
}

async function syncDirectoryBestEffort(dir: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(dir, "r");
		await handle.sync();
	} catch {
		// Some platforms/filesystems do not support fsync on directories.
	} finally {
		await handle?.close().catch(() => {});
	}
}

function createTempPath(targetPath: string): string {
	const dir = dirname(targetPath);
	const base = basename(targetPath);
	const suffix = `${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`;
	return join(dir, `.${base}.${suffix}.tmp`);
}

/**
 * Write file content through a same-directory temp file and atomic rename.
 * Existing file permissions are preserved when the destination already exists.
 */
export async function writeFileAtomically(targetPath: string, content: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const mode = await getExistingMode(targetPath);
	const tempPath = createTempPath(targetPath);
	let renamed = false;

	try {
		const handle = await open(tempPath, "wx", mode);
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		if (mode !== undefined) {
			await chmod(tempPath, mode);
		}

		throwIfAborted(signal);
		await rename(tempPath, targetPath);
		renamed = true;
		await syncDirectoryBestEffort(dirname(targetPath));
	} finally {
		if (!renamed) {
			await rm(tempPath, { force: true }).catch(() => {});
		}
	}
}
