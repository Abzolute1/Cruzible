export type AgentSessionCoordinatorArea =
	| "agent-event-loop"
	| "bash"
	| "compaction"
	| "extension-core"
	| "extension-lifecycle"
	| "model"
	| "prompt"
	| "recovery-replay"
	| "retry"
	| "runtime-bootstrap"
	| "tool-failure"
	| "tool-registry"
	| "tree"
	| "xml";

export interface AgentSessionCoordinatorOwnership {
	area: AgentSessionCoordinatorArea;
	className: string;
	primaryResponsibility: string;
	ownedState: string[];
	mayCall: AgentSessionCoordinatorArea[];
}

export const AGENT_SESSION_COORDINATOR_OWNERSHIP: AgentSessionCoordinatorOwnership[] = [
	{
		area: "agent-event-loop",
		className: "AgentSessionEventLoopCoordinator",
		primaryResponsibility:
			"Serialize agent events, queued user messages, retries, compaction checks, and XML fallback processing.",
		ownedState: ["event-loop promise", "queued event processing"],
		mayCall: ["compaction", "retry", "xml"],
	},
	{
		area: "bash",
		className: "AgentSessionBashCoordinator",
		primaryResponsibility: "Run direct user bash commands and persist their transcript messages.",
		ownedState: ["bash abort controller", "pending bash transcript messages"],
		mayCall: [],
	},
	{
		area: "compaction",
		className: "AgentSessionCompactionCoordinator",
		primaryResponsibility: "Compact session history and schedule replay after overflow or threshold recovery.",
		ownedState: ["manual compaction abort controller", "auto compaction abort controller", "overflow recovery flag"],
		mayCall: ["recovery-replay"],
	},
	{
		area: "extension-core",
		className: "AgentSessionExtensionCoreCoordinator",
		primaryResponsibility: "Bind extension context actions to the live session facade.",
		ownedState: ["extension action bindings"],
		mayCall: ["compaction", "tree"],
	},
	{
		area: "extension-lifecycle",
		className: "AgentSessionExtensionLifecycleCoordinator",
		primaryResponsibility: "Load, bind, reload, and shut down extension runtime resources.",
		ownedState: ["extension bindings", "extension shutdown handler", "extension error listener"],
		mayCall: ["extension-core", "runtime-bootstrap", "tool-registry"],
	},
	{
		area: "model",
		className: "AgentSessionModelCoordinator",
		primaryResponsibility: "Switch models, scoped models, and thinking levels.",
		ownedState: ["scoped model list", "thinking level persistence"],
		mayCall: [],
	},
	{
		area: "prompt",
		className: "AgentSessionPromptCoordinator",
		primaryResponsibility:
			"Prepare user prompts, steering context, model auth, and prompt-time tool execution state.",
		ownedState: ["steering message queue", "prompt expansion controls"],
		mayCall: ["agent-event-loop", "xml"],
	},
	{
		area: "recovery-replay",
		className: "AgentSessionRecoveryReplayScheduler",
		primaryResponsibility: "Schedule and validate stale-safe continuation replay after recovery.",
		ownedState: ["pending replay timer", "replay baseline state"],
		mayCall: [],
	},
	{
		area: "retry",
		className: "AgentSessionRetryCoordinator",
		primaryResponsibility: "Classify retryable failures and schedule retry replay.",
		ownedState: ["retry attempt count", "retry abort controller", "pending retry"],
		mayCall: ["recovery-replay"],
	},
	{
		area: "runtime-bootstrap",
		className: "AgentSessionRuntimeBootstrapCoordinator",
		primaryResponsibility: "Create and reload cwd-bound runtime services.",
		ownedState: ["runtime instance", "resource diagnostics"],
		mayCall: ["tool-registry"],
	},
	{
		area: "tool-failure",
		className: "AgentSessionToolFailureCoordinator",
		primaryResponsibility: "Track repeated tool failures and prepare corrective prompt injection.",
		ownedState: ["per-tool failure counts"],
		mayCall: [],
	},
	{
		area: "tool-registry",
		className: "AgentSessionToolRegistryCoordinator",
		primaryResponsibility: "Register, refresh, and filter active tool definitions.",
		ownedState: ["tool definition registry", "active tool list"],
		mayCall: [],
	},
	{
		area: "tree",
		className: "AgentSessionTreeCoordinator",
		primaryResponsibility: "Navigate session tree branches and optional branch summaries.",
		ownedState: ["tree navigation abort controller"],
		mayCall: [],
	},
	{
		area: "xml",
		className: "AgentSessionXmlCoordinator",
		primaryResponsibility: "Detect XML fallback tool calls and run bounded XML recovery.",
		ownedState: ["XML fallback count", "XML tool call state"],
		mayCall: [],
	},
];
