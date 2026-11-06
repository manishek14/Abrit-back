import { BotFlowState, BotFlow } from './bot-state.types';

/** Test helper: a FRESH (non-expired) state row the way parseBotState returns it. */
export function stateWith(flow: BotFlow, data: Record<string, unknown> = {}): BotFlowState {
  return {
    flow,
    data: data as BotFlowState['data'],
    updated_at: new Date().toISOString(),
  };
}
