import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const load = (f: string): string => readFileSync(`governance/agent-setup/${f}`, 'utf8');
const claudeRaw = load('claude-settings.template.json');
const agyRaw = load('antigravity-config.template.json');
const claude = JSON.parse(claudeRaw) as { permissions: { allow: string[]; deny: string[] } };
const agy = JSON.parse(agyRaw) as {
  userSettings: { enableTerminalSandbox: boolean; globalPermissionGrants: { allow: string[] } };
};

describe('agent setup templates', () => {
  it('Claude template denies credential reads and force-push', () => {
    for (const rule of [
      'Read(~/.ssh/**)',
      'Read(~/.claude/.credentials.json)',
      'Read(**/.env)',
      'Bash(git push --force*)',
      'Bash(sudo *)',
    ]) {
      expect(claude.permissions.deny).toContain(rule);
    }
  });

  it('Claude template scopes ssh to the VPS', () => {
    expect(claude.permissions.allow).not.toContain('Bash(ssh *)');
    expect(claude.permissions.allow).toContain('Bash(ssh founderos-vps *)');
  });

  it('Antigravity template has no wildcard grants and keeps the sandbox on', () => {
    const allow = agy.userSettings.globalPermissionGrants.allow;
    expect(allow.filter((g) => /\(\*\)$/.test(g))).toEqual([]);
    expect(allow.some((g) => g.startsWith('unsandboxed('))).toBe(false);
    expect(agy.userSettings.enableTerminalSandbox).toBe(true);
  });

  it('templates carry no secrets or absolute home paths', () => {
    for (const raw of [claudeRaw, agyRaw]) {
      expect(raw).not.toMatch(/\/Users\/|ak_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}/);
    }
  });
});
