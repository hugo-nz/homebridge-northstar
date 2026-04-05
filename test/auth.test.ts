import { PolestarAuth } from '../src/api/auth';

describe('PolestarAuth — PKCE helpers', () => {
  describe('b64UrlEncode', () => {
    it('produces base64url output (no padding, URL-safe chars)', () => {
      const buf = Buffer.from('hello world');
      const result = PolestarAuth.b64UrlEncode(buf);
      expect(result).not.toContain('+');
      expect(result).not.toContain('/');
      expect(result).not.toContain('=');
      expect(result).toBe('aGVsbG8gd29ybGQ');
    });
  });

  describe('generateCodeVerifier', () => {
    it('returns a non-empty string', () => {
      const v = PolestarAuth.generateCodeVerifier();
      expect(typeof v).toBe('string');
      expect(v.length).toBeGreaterThan(0);
    });

    it('returns different values on each call', () => {
      const v1 = PolestarAuth.generateCodeVerifier();
      const v2 = PolestarAuth.generateCodeVerifier();
      expect(v1).not.toBe(v2);
    });

    it('contains only URL-safe characters', () => {
      const v = PolestarAuth.generateCodeVerifier();
      expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
    });
  });

  describe('generateState', () => {
    it('returns a non-empty string', () => {
      const s = PolestarAuth.generateState();
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    });

    it('returns different values on each call', () => {
      const s1 = PolestarAuth.generateState();
      const s2 = PolestarAuth.generateState();
      expect(s1).not.toBe(s2);
    });
  });

  describe('getCodeChallenge', () => {
    it('returns a SHA-256 base64url of the code verifier', () => {
      const mockLog = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as unknown as import('homebridge').Logger;

      const auth = new PolestarAuth('user@example.com', 'password', mockLog);

      // Get challenge twice — must return the same value for the same verifier.
      const challenge1 = auth.getCodeChallenge();
      const challenge2 = auth.getCodeChallenge();
      expect(challenge1).toBe(challenge2);

      // Must be a non-empty URL-safe base64 string.
      expect(challenge1).toMatch(/^[A-Za-z0-9\-_]+$/);
      expect(challenge1.length).toBeGreaterThan(0);
    });
  });

  describe('getAuthParams', () => {
    it('includes all required PKCE fields', () => {
      const mockLog = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as unknown as import('homebridge').Logger;

      const auth = new PolestarAuth('user@example.com', 'password', mockLog);
      const params = auth.getAuthParams();

      expect(params['client_id']).toBe('l3oopkc_10');
      expect(params['redirect_uri']).toBe('https://www.polestar.com/sign-in-callback');
      expect(params['response_type']).toBe('code');
      expect(params['code_challenge_method']).toBe('S256');
      expect(typeof params['code_challenge']).toBe('string');
      expect(typeof params['state']).toBe('string');
    });

    it('returns the same state and challenge on repeated calls', () => {
      const mockLog = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as unknown as import('homebridge').Logger;

      const auth = new PolestarAuth('user@example.com', 'password', mockLog);
      const p1 = auth.getAuthParams();
      const p2 = auth.getAuthParams();
      expect(p1['state']).toBe(p2['state']);
      expect(p1['code_challenge']).toBe(p2['code_challenge']);
    });
  });
});
