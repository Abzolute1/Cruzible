/**
 * PKCE utilities using Web Crypto API.
 * Works in both Node.js 20+ and browsers.
 */

/**
 * Encode bytes as base64url string.
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Generate PKCE code verifier and challenge.
 * Uses Web Crypto API for cross-platform compatibility.
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// Generate random verifier
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// Compute SHA-256 challenge
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}

/**
 * Generate a random OAuth state parameter.
 * Must be independent of the PKCE verifier: the state ends up in the redirect
 * URL alongside the authorization code, so reusing the verifier would nullify
 * PKCE's interception protection. Uses Web Crypto API for cross-platform
 * compatibility.
 */
export function generateState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64urlEncode(bytes);
}
