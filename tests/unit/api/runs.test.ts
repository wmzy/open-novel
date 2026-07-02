import { describe, it, expect } from 'vitest';
import { sanitizeStderr } from '../../../src/api/routes/runs';

describe('sanitizeStderr', () => {
  it('redacts OpenAI/Anthropic-style API keys (sk-...)', () => {
    const input = 'Error: invalid api key sk-ant-abc123def456ghi789jkl012mno345pqr';
    const out = sanitizeStderr(input);
    expect(out).toContain('sk-[REDACTED]');
    expect(out).not.toContain('sk-ant-abc123');
  });

  it('redacts Bearer tokens', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test_payload.signature';
    const out = sanitizeStderr(input);
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('eyJhbGci');
  });

  it('redacts key=value credential pairs', () => {
    const cases = [
      'config: api_key=AIzaSyABCDEFGHIJKLMN0123456789xyz',
      'env: token="ghp_abcdef1234567890abcdef"',
      "set secret: 'mySuperSecretValue123'",
      'password=hunter2passwordExtra',
    ];
    for (const input of cases) {
      const out = sanitizeStderr(input);
      expect(out).toContain('[REDACTED]');
      // The original long secret value must not survive
      expect(out).not.toMatch(/(AIzaSy|ghp_|mySuperSecretValue|hunter2passwordExtra)/);
    }
  });

  it('preserves normal file paths and debug messages', () => {
    const input = 'WARN: /home/user/projects/novel/.novel/chapters/ch1.md not found\nDebug: agent started in /home/user/projects/novel';
    const out = sanitizeStderr(input);
    expect(out).toBe(input);
  });

  it('handles mixed content: path + secret in same line', () => {
    const input = 'Error reading /home/user/.config/key: api_key=sk-live-1234567890abcdefghijklmnop';
    const out = sanitizeStderr(input);
    expect(out).toContain('/home/user/.config/key');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('sk-live-1234567890');
  });

  it('handles empty string', () => {
    expect(sanitizeStderr('')).toBe('');
  });
});
