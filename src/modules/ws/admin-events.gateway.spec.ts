import { JwtService } from '@nestjs/jwt';
import { AdminEventsGateway } from './admin-events.gateway';
import { setTestEnv } from '../../common/testing/test-env';

setTestEnv();

const mkClient = (token?: string, authorization?: string) => ({
  id: 'sock-1',
  handshake: {
    auth: token === undefined ? {} : { token },
    headers: authorization ? { authorization } : {},
  },
  join: jest.fn(),
  disconnect: jest.fn(),
});

describe('AdminEventsGateway', () => {
  let jwt: { verifyAsync: jest.Mock };
  let gateway: AdminEventsGateway;

  beforeEach(() => {
    jwt = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'a-1' }) };
    gateway = new AdminEventsGateway(jwt as unknown as JwtService);
  });

  it('rejects sockets without a token', async () => {
    const client = mkClient();
    await gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('rejects sockets with an invalid token', async () => {
    jwt.verifyAsync.mockRejectedValueOnce(new Error('jwt expired'));
    const client = mkClient('bad-token');
    await gateway.handleConnection(client as never);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  it('joins verified admins to the admins room (also accepts the Authorization header)', async () => {
    const a = mkClient('good-token');
    await gateway.handleConnection(a as never);
    expect(a.join).toHaveBeenCalledWith('admins');

    const b = mkClient(undefined, 'Bearer good-token');
    await gateway.handleConnection(b as never);
    expect(b.join).toHaveBeenCalledWith('admins');
  });

  it('broadcasts events to the admins room when the server is up', () => {
    const emit = jest.fn();
    (gateway as unknown as { server: unknown }).server = {
      to: jest.fn(() => ({ emit })),
    };

    gateway.broadcast('message:new', { id: 'm-1' });

    expect((gateway as unknown as { server: { to: jest.Mock } }).server.to).toHaveBeenCalledWith('admins');
    expect(emit).toHaveBeenCalledWith('message:new', { id: 'm-1' });
  });

  it('ignores broadcasts before the server is initialized (boot window)', () => {
    expect(() => gateway.broadcast('ticket:new', {})).not.toThrow();
  });
});
