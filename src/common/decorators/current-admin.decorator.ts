import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Admin identity attached to the request by the JWT guard (id, email, name). */
export interface CurrentAdminPayload {
  sub: string;
  email: string;
  name: string;
}

export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CurrentAdminPayload | undefined =>
    ctx.switchToHttp().getRequest().admin,
);
