export function buildTaggedPromptSection(tag: string, content: string): string {
	return `<${tag}>\n${content.trim()}\n</${tag}>`;
}

export function buildTaggedPromptBundle(
	sections: Array<{
		tag: string;
		content: string | undefined;
	}>,
): string {
	return sections
		.map((section) => {
			const content = section.content?.trim();
			if (!content) return undefined;
			return buildTaggedPromptSection(section.tag, content);
		})
		.filter((section): section is string => typeof section === "string")
		.join("\n\n");
}

export function appendTaggedPromptSection(basePrompt: string, tag: string, content: string | undefined): string {
	const trimmed = content?.trim();
	if (!trimmed) {
		return basePrompt;
	}
	return `${basePrompt}\n\n${buildTaggedPromptSection(tag, trimmed)}`;
}
