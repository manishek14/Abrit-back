import { ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

/** PostgreSQL BIGINT max (2^63 − 1) — the hard ceiling for message id cursors. */
export const BIGINT_MAX = '9223372036854775807';

/**
 * Message-id cursor validation (review fix): digits only, 1..BIGINT_MAX.
 * The previous `^\d{1,19}$` regex alone let 19-digit values ABOVE the bigint
 * range through (e.g. 9999999999999999999), which later crashed the query
 * with a database error (HTTP 500) instead of a clean 400.
 *
 * Equal-length digit strings compare correctly lexicographically, so the
 * boundary check needs no bigint arithmetic.
 */
@ValidatorConstraint({ name: 'isMessageIdCursor', async: false })
export class IsMessageIdCursorConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    if (!/^\d{1,19}$/.test(value)) return false;
    if (value === '0') return false; // message ids start at 1; zero is never a cursor
    return value.length < 19 || value <= BIGINT_MAX;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a numeric message id between 1 and ${BIGINT_MAX}`;
  }
}
