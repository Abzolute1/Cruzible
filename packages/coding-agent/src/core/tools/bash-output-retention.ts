import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function shouldRetainBashFullOutput(): boolean {
	return /^(1|true|yes)$/i.test(process.env.AG1_RETAIN_BASH_FULL_OUTPUT ?? "");
}

export function getBashFullOutputTempPath(): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `ag1-bash-${id}.log`);
}
