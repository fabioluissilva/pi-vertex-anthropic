import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extension from "../index.ts";

// Regression guard: AnthropicVertex starts google-auth-library's getClient() in
// its constructor and awaits it only inside a request. When ADC is broken, that
// promise rejects before anything awaits it, and Node's default
// unhandled-rejection mode crashed the whole pi process instead of failing the
// request. No google-auth-library mock here: the real one must fail.
describe("Vertex client with broken ADC", () => {
	const ENV = ["ANTHROPIC_VERTEX_PROJECT_ID", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_LOCATION"] as const;
	let saved: Record<string, string | undefined>;
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);

	beforeEach(() => {
		saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
		process.env.ANTHROPIC_VERTEX_PROJECT_ID = "broken-adc-project";
		process.env.GOOGLE_APPLICATION_CREDENTIALS = "/pi-vertex/does-not-exist.json";
		process.env.GOOGLE_CLOUD_LOCATION = "global";
		unhandled.length = 0;
		process.on("unhandledRejection", onUnhandled);
	});

	afterEach(() => {
		process.off("unhandledRejection", onUnhandled);
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	it("fails the request with the ADC error instead of an unhandled rejection", async () => {
		let config: any;
		extension({
			registerProvider: (_name: string, c: unknown) => {
				config = c;
			},
		} as unknown as Parameters<typeof extension>[0]);
		const definition = config.models.find((m: { id: string }) => m.id === "claude-haiku-4-5@20251001");
		const model = {
			...definition,
			api: config.api,
			provider: "vertex-anthropic",
			baseUrl: config.baseUrl,
		} as unknown as Model<Api>;
		const context = normalizeContext({
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		} as unknown as Context);

		const errors: string[] = [];
		for await (const event of config.streamSimple(model, context, { maxRetries: 0 })) {
			if (event.type === "error") errors.push(String(event.error.errorMessage));
		}
		// Let Node report any rejection that nothing handled.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(unhandled).toEqual([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatch(/Google OAuth credentials/);
	});
});
