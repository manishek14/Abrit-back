import { SetMetadata } from '@nestjs/common';

/**
 * Marks an endpoint as exempt from the double-submit CSRF check (see
 * CsrfGuard). Used ONLY for the two public auth endpoints:
 *  - /auth/login  — there is no session/csrf cookie pair yet to double-submit;
 *                   login CSRF is additionally mitigated by the credential
 *                   check + rate limiting (5/min/IP).
 *  - /auth/logout — must stay usable even when the session cookie was already
 *                   cleared/expired; clearing a cookie is not a state attack
 *                   surface (it can only log the attacker out as well).
 */
export const CSRF_EXEMPT_KEY = 'csrf:exempt';
export const CsrfExempt = (): MethodDecorator & ClassDecorator =>
  SetMetadata(CSRF_EXEMPT_KEY, true);
