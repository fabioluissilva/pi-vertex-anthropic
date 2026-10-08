import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import { describe, expect, it } from "vitest";

// Regression guard for the @anthropic-ai/vertex-sdk <-> @anthropic-ai/sdk pairing.
//
// vertex-sdk rewrites the canonical Anthropic path (/v1/messages) into Vertex's
// wire shape (.../publishers/anthropic/models/<model>:streamRawPredict) and
// injects Google OAuth through a `backendMiddleware()` hook that only exists in
// @anthropic-ai/sdk >=0.103.0. If the transitive core SDK ever resolves below
// that floor, the hook never runs, the request goes out as <baseURL>/v1 +
// /v1/messages = .../v1/v1/messages, and every call 404s at Google. The
// ">=0.103.0 <1" floor in package.json is what prevents that; this test fails
// loudly if the resolved dependency tree regresses before it can ship.
// pi-ai 1.0 sends through client.beta.messages (/v1/messages?beta=true), and
// pi-ai 0.79 sent through client.messages, so both paths must be rewritten.
const REQUEST = {
	model: "claude-opus-4-8",
	max_tokens: 16,
	messages: [{ role: "user" as const, content: "ping" }],
	stream: true as const,
};

describe("vertex-sdk wire shape (dependency integration)", () => {
	it.each([
		["messages", (client: AnthropicVertex) => client.messages.create(REQUEST)],
		["beta.messages", (client: AnthropicVertex) => client.beta.messages.create(REQUEST)],
	] as const)("rewrites %s.create to the Vertex :streamRawPredict path", async (_name, send) => {
		let capturedUrl: string | undefined;

		const capturingFetch = async (input: string | URL) => {
			capturedUrl = typeof input === "string" ? input : input.href;
			// Abort before any real network call; we only care about the URL.
			throw new Error("__captured__");
		};

		const client = new AnthropicVertex({
			projectId: "test-project",
			region: "global",
			maxRetries: 0,
			// Stub the ADC client so the OAuth step that precedes the URL rewrite
			// resolves without real Google credentials. It returns a Headers, as
			// google-auth-library's AuthClient does: vertex-sdk calls .get() on it.
			authClient: { getRequestHeaders: async () => new Headers() },
			fetch: capturingFetch,
		} as unknown as ConstructorParameters<typeof AnthropicVertex>[0]);

		await expect(send(client)).rejects.toThrow();

		expect(capturedUrl).toBeDefined();
		expect(capturedUrl).toContain("/publishers/anthropic/models/claude-opus-4-8:streamRawPredict");
		expect(capturedUrl).not.toContain("/v1/v1/messages");
		expect(capturedUrl).not.toContain("beta=true");
	});
});
