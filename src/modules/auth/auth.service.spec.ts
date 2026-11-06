import { UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';
import { Admin } from '../../database/entities/admin.entity';
import { setTestEnv } from '../../common/testing/test-env';

setTestEnv();

describe('AuthService', () => {
  let admins: { findOne: jest.Mock };
  let jwt: { signAsync: jest.Mock };
  let service: AuthService;
  const passwordHash = bcrypt.hashSync('Admin1234!', 4);

  const mkAdmin = (over: Partial<Admin> = {}): Admin =>
    ({
      id: 'a-1',
      email: 'admin@abrit.local',
      password_hash: passwordHash,
      name: 'Super Admin',
      ...over,
    }) as Admin;

  beforeEach(() => {
    admins = { findOne: jest.fn() };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed-jwt') };
    service = new AuthService(admins as unknown as Repository<Admin>, jwt as unknown as JwtService);
  });

  it('returns a token and the public admin profile on valid credentials', async () => {
    admins.findOne.mockResolvedValueOnce(mkAdmin());

    const res = await service.login('admin@abrit.local', 'Admin1234!');

    expect(res.accessToken).toBe('signed-jwt');
    expect(res.admin).toEqual({ id: 'a-1', email: 'admin@abrit.local', name: 'Super Admin' });
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'a-1', email: 'admin@abrit.local', name: 'Super Admin' });
    // the password hash never travels out
    expect(JSON.stringify(res)).not.toContain('password_hash');
  });

  it('normalizes the email before lookup', async () => {
    admins.findOne.mockResolvedValueOnce(mkAdmin());
    await service.login('  Admin@Abrit.LOCAL ', 'Admin1234!');
    expect(admins.findOne).toHaveBeenCalledWith({ where: { email: 'admin@abrit.local' } });
  });

  it('rejects a wrong password with 401 (no hint about which part failed)', async () => {
    admins.findOne.mockResolvedValueOnce(mkAdmin());
    await expect(service.login('admin@abrit.local', 'WrongPass1!')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an unknown email with 401', async () => {
    admins.findOne.mockResolvedValueOnce(null);
    await expect(service.login('ghost@abrit.local', 'Admin1234!')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  // --- review round 6 (P2 session security): GET /auth/me session restore ---

  it('me() returns the public profile of the signed-in admin', async () => {
    admins.findOne.mockResolvedValueOnce(mkAdmin());

    await expect(service.me('a-1')).resolves.toEqual({
      id: 'a-1',
      email: 'admin@abrit.local',
      name: 'Super Admin',
    });
    expect(admins.findOne).toHaveBeenCalledWith({ where: { id: 'a-1' } });
  });

  it('me() returns the profile WITHOUT the password hash', async () => {
    admins.findOne.mockResolvedValueOnce(mkAdmin());

    const profile = await service.me('a-1');
    expect(JSON.stringify(profile)).not.toContain('password_hash');
  });

  it('me() rejects with 401 when the admin no longer exists (deleted account)', async () => {
    admins.findOne.mockResolvedValueOnce(null);
    await expect(service.me('deleted-id')).rejects.toThrow(UnauthorizedException);
  });
});
