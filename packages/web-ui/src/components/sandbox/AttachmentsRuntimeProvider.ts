import { ATTACHMENTS_RUNTIME_DESCRIPTION } from "../../prompts/prompts.js";
import type { Attachment } from "../../utils/attachment-utils.js";
import type { SandboxRuntimeProvider } from "./SandboxRuntimeProvider.js";

/**
 * Attachments Runtime Provider
 *
 * OPTIONAL provider that provides file access APIs to sandboxed code.
 * Only needed when attachments are present.
 * Only attachment metadata is injected into the sandbox; contents are read on
 * demand through the runtime message bridge, so untrusted sandbox code never
 * receives base64 payloads of every attachment up front.
 */
export class AttachmentsRuntimeProvider implements SandboxRuntimeProvider {
	constructor(private attachments: Attachment[]) {}

	getData(): Record<string, any> {
		const attachmentsData = this.attachments.map((a) => ({
			id: a.id,
			fileName: a.fileName,
			mimeType: a.mimeType,
			size: a.size,
		}));

		return { attachments: attachmentsData };
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified, so no external references!
		return (_sandboxId: string) => {
			(window as any).listAttachments = () =>
				((window as any).attachments || []).map((a: any) => ({
					id: a.id,
					fileName: a.fileName,
					mimeType: a.mimeType,
					size: a.size,
				}));

			// Attachment contents are NOT injected into the sandbox; they are
			// fetched on demand through the runtime message bridge.
			(window as any).readTextAttachment = async (attachmentId: string): Promise<string> => {
				if (!(window as any).sendRuntimeMessage) {
					throw new Error("Attachments are not available in offline mode");
				}
				const response = await (window as any).sendRuntimeMessage({
					type: "attachment-operation",
					action: "readText",
					id: attachmentId,
				});
				if (!response.success) throw new Error(response.error);
				return response.result;
			};

			(window as any).readBinaryAttachment = async (attachmentId: string): Promise<Uint8Array> => {
				if (!(window as any).sendRuntimeMessage) {
					throw new Error("Attachments are not available in offline mode");
				}
				const response = await (window as any).sendRuntimeMessage({
					type: "attachment-operation",
					action: "readBinary",
					id: attachmentId,
				});
				if (!response.success) throw new Error(response.error);
				const bin = atob(response.result);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				return bytes;
			};
		};
	}

	async handleMessage(message: any, respond: (response: any) => void): Promise<void> {
		if (message.type !== "attachment-operation") {
			return;
		}

		const { action, id } = message;
		const attachment = this.attachments.find((a) => a.id === id);
		if (!attachment) {
			respond({ success: false, error: `Attachment not found: ${id}` });
			return;
		}

		try {
			switch (action) {
				case "readText": {
					if (attachment.extractedText) {
						respond({ success: true, result: attachment.extractedText });
						break;
					}
					try {
						respond({ success: true, result: atob(attachment.content) });
					} catch {
						respond({ success: false, error: `Failed to decode text content for: ${id}` });
					}
					break;
				}

				case "readBinary": {
					// Transfer as base64 string; the sandbox decodes it to Uint8Array
					respond({ success: true, result: attachment.content });
					break;
				}

				default:
					respond({ success: false, error: `Unknown attachment action: ${action}` });
			}
		} catch (error: any) {
			respond({ success: false, error: error.message });
		}
	}

	getDescription(): string {
		return ATTACHMENTS_RUNTIME_DESCRIPTION;
	}
}
