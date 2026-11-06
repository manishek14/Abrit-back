import { IsOptional, IsString, Validate, ValidationError, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BIGINT_MAX, IsMessageIdCursorConstraint } from './message-id-cursor.validator';

class CursorDto {
  @IsOptional()
  @IsString()
  @Validate(IsMessageIdCursorConstraint)
  cursor?: string;
}

const validateCursor = async (cursor: string): Promise<ValidationError[]> =>
  validate(plainToInstance(CursorDto, { cursor }));

describe('IsMessageIdCursor (bigint range validation — review fix)', () => {
  it('accepts ordinary message ids and the exact bigint boundary', async () => {
    for (const cursor of ['1', '42', '9223372036854775807']) {
      expect(await validateCursor(cursor)).toHaveLength(0);
    }
  });

  it('rejects 19-digit values ABOVE bigint max — the old regex let these through', async () => {
    const errors = await validateCursor('9999999999999999999');
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints?.isMessageIdCursor).toContain('between 1 and');
  });

  it('rejects zero, negatives, non-numbers and above-range values', async () => {
    for (const cursor of ['0', '-1', 'abc', '12a', '1.5', '9223372036854775808', '12345678901234567890']) {
      expect(await validateCursor(cursor)).toHaveLength(1);
    }
  });

  it('treats an absent cursor as valid (optional) and exposes BIGINT_MAX', async () => {
    expect(await validate(plainToInstance(CursorDto, {}))).toHaveLength(0);
    expect(BIGINT_MAX).toBe('9223372036854775807');
  });
});
