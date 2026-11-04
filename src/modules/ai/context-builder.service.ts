import { Injectable } from '@nestjs/common';
import { getEnv } from '../../config/env';
import { MessageRole } from '../../database/enums';
import { MessagesService } from '../messages/messages.service';
import { ChatMessage } from './ai-provider.interface';

export interface BuiltContext {
  messages: ChatMessage[];
  includedCount: number;
  truncated: boolean;
}

/**
 * The heart of "independent memory" (plan §7): the context contains ONLY the
 * last N messages of THE SAME ticket_id. System announcements never reach the
 * model; admin messages speak as 'assistant'; consecutive same-role messages
 * merge; a character budget trims the OLDEST entries but always keeps the last
 * user message. Isolation is guaranteed by the query itself — not by prompt
 * instructions.
 */
@Injectable()
export class ContextBuilderService {
  constructor(private readonly messagesService: MessagesService) {}

  async build(ticketId: string, systemPrompt: string): Promise<BuiltContext> {
    const env = getEnv();

    const recent = await this.messagesService.getRecentConversation(
      ticketId,
      env.AI_CONTEXT_MAX_MESSAGES,
    );

    const mapped: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of recent) {
      if (m.role === MessageRole.SYSTEM) continue;
      const role: 'user' | 'assistant' = m.role === MessageRole.USER ? 'user' : 'assistant';
      const last = mapped[mapped.length - 1];
      if (last && last.role === role) {
        last.content += '\n' + m.content;
      } else {
        mapped.push({ role, content: m.content });
      }
    }

    const budget = env.AI_CONTEXT_MAX_CHARS - systemPrompt.length;
    let chars = mapped.reduce((sum, m) => sum + m.content.length, 0);
    let truncated = false;
    while (mapped.length > 1 && chars > budget) {
      chars -= mapped.shift()!.content.length;
      truncated = true;
    }

    return {
      messages: [{ role: 'system', content: systemPrompt }, ...mapped],
      includedCount: mapped.length,
      truncated,
    };
  }
}
