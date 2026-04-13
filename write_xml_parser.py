import os

content = r'''/**
 * XML tool call parser for model-agnostic tool execution.
 *
 * Handles models (like Qwen3.5) that emit tool calls in XML format instead of
 * the OpenAI structured tool call format. This makes the harness agnostic to
 * the model's native tool-calling syntax.
 *
 * False positive prevention:
 * 1. Only matches known active tool names (read, bash, edit, write, etc.)
 * 2. Requires valid parameter tags
 * 3. Strips content inside code blocks
 * 4. Only triggers when no structured tool calls were executed this turn
 * 5. Max 3 XML iterations per user prompt to prevent infinite loops
 */

export interface XmlToolCall {
    name: string;
    id: string;
    arguments: Record<string, string>;
    rawXml: string;
}

export function stripCodeBlocks(text: string): string {
    return text.replace(/```[\s\S]*?```/g, '');
}

export function parseXmlToolCalls(text: string, knownToolNames: string[]): XmlToolCall[] {
    const strippedText = stripCodeBlocks(text);
    const calls: XmlToolCall[] = [];
    let callIndex = 0;

    const escapedNames = knownToolNames.map(name =>
        name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );

    if (escapedNames.length === 0) return [];

    const namePattern = escapedNames.join('|');
    // Match <toolName attrs...>content</toolName> -- closing tag name must match
    const funcRegex = new RegExp(`<(${namePattern})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1>`, 'gi');

    let match: RegExpExecArray | null;
    while ((match = funcRegex.exec(strippedText)) !== null) {
        const toolName = match[1];
        const content = match[2];
        const rawXml = match[0];

        const args: Record<string, string> = {};

        // Support both 