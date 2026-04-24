interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

const STDOUT_TAKEOVER_STATE_KEY = Symbol.for("ag1.stdoutTakeoverState");
const STDOUT_TAKEOVER_ENV = "CRUCIBLE_STDOUT_TAKEN_OVER";
const stdoutGuardGlobal = globalThis as typeof globalThis & {
	[STDOUT_TAKEOVER_STATE_KEY]?: StdoutTakeoverState;
};

function getStdoutTakeoverState(): StdoutTakeoverState | undefined {
	return stdoutGuardGlobal[STDOUT_TAKEOVER_STATE_KEY];
}

function setStdoutTakeoverState(state: StdoutTakeoverState | undefined): void {
	if (state) {
		stdoutGuardGlobal[STDOUT_TAKEOVER_STATE_KEY] = state;
		process.env[STDOUT_TAKEOVER_ENV] = "1";
		return;
	}
	delete stdoutGuardGlobal[STDOUT_TAKEOVER_STATE_KEY];
	delete process.env[STDOUT_TAKEOVER_ENV];
}

export function takeOverStdout(): void {
	if (getStdoutTakeoverState()) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	setStdoutTakeoverState({
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	});
}

export function restoreStdout(): void {
	const stdoutTakeoverState = getStdoutTakeoverState();
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	setStdoutTakeoverState(undefined);
}

export function isStdoutTakenOver(): boolean {
	return getStdoutTakeoverState() !== undefined || process.env[STDOUT_TAKEOVER_ENV] === "1";
}

export function writeRawStdout(text: string): void {
	const stdoutTakeoverState = getStdoutTakeoverState();
	if (stdoutTakeoverState) {
		stdoutTakeoverState.rawStdoutWrite(text);
		return;
	}
	process.stdout.write(text);
}

export async function flushRawStdout(): Promise<void> {
	const stdoutTakeoverState = getStdoutTakeoverState();
	if (stdoutTakeoverState) {
		await new Promise<void>((resolve, reject) => {
			stdoutTakeoverState.rawStdoutWrite("", (err) => {
				if (err) reject(err);
				else resolve();
			});
		});
		return;
	}

	await new Promise<void>((resolve, reject) => {
		process.stdout.write("", (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}
