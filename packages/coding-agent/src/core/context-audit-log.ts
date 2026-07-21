import type { Message } from "@ag1/ai";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

export interface ContextAuditLogger {
	write(messages: Message[], metadata?: Record<string, unknown>): void;
}

export interface ContextAuditLoggerOptions {
	sessionId: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	now?: () => Date;
}

const REDACTED = "[redacted]";
const SENSITIVE_FIELD_PATTERN =
	/(^|[_-])(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|password|secret)([_-]|$)/i;

function redactString(value: string): string {
	return value
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${REDACTED}`)
		.replace(/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)[^\s"']+/gi, `$1${REDACTED}`)
		.replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g, REDACTED);
}

function redactContextAuditValue(value: unknown, key?: string): unknown {
	if (key && SENSITIVE_FIELD_PATTERN.test(key)) {
		return REDACTED;
	}

	if (typeof value === "string") {
		return redactString(value);
	}

	if (Array.isArray(value)) {
		return value.map((item) => redactContextAuditValue(item));
	}

	if (value && typeof value === "object") {
		const redacted: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) {
			redacted[entryKey] = redactContextAuditValue(entryValue, entryKey);
		}
		return redacted;
	}

	return value;
}

export function createContextAuditLogger(options: ContextAuditLoggerOptions): ContextAuditLogger {
	const env = options.env ?? process.env;
	const auditDir = env.AG1_CONTEXT_AUDIT_DIR;
	if (!auditDir) {
		return { write: () => undefined };
	}

	let sequence = 0;
	const now = options.now ?? (() => new Date());
	return {
		write(messages, metadata = {}) {
			mkdirSync(auditDir, { recursive: true, mode: 0o700 });
			sequence += 1;
			const timestamp = now().toISOString();
			const safeSessionId = options.sessionId.replace(/[^a-zA-Z0-9_.-]/g, "-");
			const filename = `${timestamp.replace(/[:.]/g, "-")}-${safeSessionId}-${String(sequence).padStart(4, "0")}.json`;
			const payload = redactContextAuditValue({
				timestamp,
				sessionId: options.sessionId,
				cwd: options.cwd,
				messageCount: messages.length,
				...metadata,
				messages,
			});
			writeFileSync(join(auditDir, filename), `${JSON.stringify(payload, null, 2)}\n`, {
				mode: 0o600,
			});
		},
	};
}
