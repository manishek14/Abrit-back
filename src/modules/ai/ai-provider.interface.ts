/** Minimal low-level seam between the app and the LLM (plan §7). Tests swap this for a fake. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCompleteRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface AiCompleteResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: Record<string, unknown>;
}

export interface AiProvider {
  complete(req: AiCompleteRequest): Promise<AiCompleteResult>;
}

export const AI_PROVIDER = Symbol('AI_PROVIDER');
