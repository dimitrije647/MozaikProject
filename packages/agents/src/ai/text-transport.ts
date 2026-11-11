import { OpenAIResponses, type InferenceInput, type InferenceOutput } from '@mozaik-ai/core';
import type { ProviderVendor } from './errors';
import type { OpenAIClient } from './openai-http';
import { textCostUsd, textReserveUsd } from './pricing';

export interface AttachedImage {
  mediaType: string;
  base64: string;
}

/** One request, ready to send: the provider body plus what the budget needs to know about it. */
export interface TextCall {
  body: Record<string, unknown>;
  model: string;
  /** The output cap actually sent (for Claude this includes the adaptive-thinking headroom). */
  maxTokens: number;
}

export interface TextResult {
  output: InferenceOutput;
  /** The answer was cut off by the output cap (worth one retry with a bigger cap). */
  cutOff: boolean;
  /** USD from the usage the provider reported; null = no verified price (counted as unpriced, never as free). */
  costUsd: number | null;
  /** The model declined (Claude `stop_reason: "refusal"`): billed, not retried. */
  refused?: boolean;
}

/**
 * What the InferenceGateway needs from ONE text provider. The gateway owns the call budget, retries, timeouts, cancellation and the spend
 * ledger; a transport only knows its provider's wire format. Every implementation keeps the API key out of reach (private fields) and never
 * copies provider text into errors.
 */
export interface TextTransport {
  readonly provider: ProviderVendor;
  build(input: InferenceInput, cap: number, images: AttachedImage[] | undefined): TextCall;
  send(call: TextCall, signal: AbortSignal): Promise<Record<string, unknown>>;
  parse(raw: Record<string, unknown>, call: TextCall): TextResult;
  /** Worst case of the call in USD, reserved before it is sent. */
  reserveUsd(call: TextCall): number | null;
}

// Mozaik's default OpenAI Responses mapper: converts a ModelContext to a Responses request and a Responses reply back to Mozaik items.
// Constructing the endpoint only stores config (no client, no env access); only its public mapper is used.
const openAiMapper = new OpenAIResponses().endpointMapper;

/** OpenAI Responses API (the behaviour LaunchPilot always had: output cap, `store: false`, low-detail vision). */
export class OpenAITransport implements TextTransport {
  readonly provider = 'openai' as const;
  constructor(readonly client: OpenAIClient) {}

  build(input: InferenceInput, cap: number, images: AttachedImage[] | undefined): TextCall {
    const request = openAiMapper.toRequest(input) as { input: { role?: string; content?: unknown[] }[]; model?: string };
    if (images?.length) {
      const lastUser = [...request.input].reverse().find((i) => i.role === 'user');
      if (lastUser?.content) for (const img of images) lastUser.content.push({ type: 'input_image', image_url: `data:${img.mediaType};base64,${img.base64}`, detail: 'low' });
    }
    const body = { ...request, max_output_tokens: cap, store: false /* do not let OpenAI retain the user's product text */ };
    return { body, model: request.model ?? input.model, maxTokens: cap };
  }

  send(call: TextCall, signal: AbortSignal) {
    return this.client.createResponse(call.body, signal);
  }

  parse(raw: Record<string, unknown>, call: TextCall): TextResult {
    const output = openAiMapper.toResponse(raw);
    const u = output.tokenUsage;
    const cutOff = raw.status === 'incomplete' && (raw.incomplete_details as { reason?: string } | null | undefined)?.reason === 'max_output_tokens';
    return { output, cutOff, costUsd: u ? textCostUsd(call.model, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedInputTokens: u.inputTokenDetails.cached_tokens }) : null };
  }

  reserveUsd(call: TextCall) {
    return textReserveUsd(call.model, JSON.stringify(call.body).length, call.maxTokens);
  }
}
