import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { getEnv } from '../../config/env';
import { CurrentAdminPayload } from '../../common/decorators/current-admin.decorator';
import { SESSION_COOKIE_NAME, readCookieHeader } from '../auth/session-cookies';

/**
 * Realtime channel for the admin panel (the owner's WebSocket requirement):
 * auth happens with the SAME session as the REST API — in order of precedence:
 *   1. handshake.auth.token            (API clients; Bearer-equivalent)
 *   2. the Authorization header        (Bearer)
 *   3. the HttpOnly abrit_session cookie (the panel — review round 6, P2:
 *      the cookie is sent on the WebSocket handshake automatically, so the
 *      browser-side JS never needs the raw token). CSRF does not apply: a
 *      cross-site page cannot open a WebSocket with someone else's cookie
 *      AND the gateway CORS origin allowlist rejects foreign origins.
 * Every verified admin joins the shared "admins" room and instantly receives
 * ticket/message/status events. The frontend keeps a polling fallback for when
 * the socket is disconnected (hybrid strategy).
 */
@WebSocketGateway({
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, ok?: boolean) => void) => {
      const allowed = getEnv()
        .CORS_ORIGIN.split(',')
        .map((o) => o.trim())
        .filter(Boolean);
      if (!origin || allowed.includes(origin)) return callback(null, true);
      return callback(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
  },
})
export class AdminEventsGateway implements OnGatewayConnection {
  private readonly logger = new Logger('WsGateway');
  public static readonly ADMIN_ROOM = 'admins';

  @WebSocketServer()
  server?: Server;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const auth = client.handshake.auth as { token?: string } | undefined;
    const header = client.handshake.headers?.authorization;
    const cookieToken = readCookieHeader(client.handshake.headers?.cookie, SESSION_COOKIE_NAME);
    const token =
      auth?.token ??
      (typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined) ??
      cookieToken;

    if (!token) {
      this.logger.warn(`socket ${client.id} rejected: no token`);
      client.disconnect(true);
      return;
    }
    try {
      await this.jwt.verifyAsync<CurrentAdminPayload>(token);
      client.join(AdminEventsGateway.ADMIN_ROOM);
      this.logger.log(`admin socket connected: ${client.id}`);
    } catch {
      this.logger.warn(`socket ${client.id} rejected: invalid token`);
      client.disconnect(true);
    }
  }

  broadcast(event: string, payload: unknown): void {
    if (!this.server) return;
    this.server.to(AdminEventsGateway.ADMIN_ROOM).emit(event, payload);
  }
}
