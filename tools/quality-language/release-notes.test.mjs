import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseNotes } from './release-notes.mjs';

function fixture({ authenticated = true, quota = 80, text = '{"items":[]}', finishReason = 'stop' } = {}) {
  const events = [], handlers = new Map(); let clientOptions, sessionOptions;
  const client = { start: async () => events.push('start'), stop: async () => events.push('stop'),
    getAuthStatus: async () => ({ isAuthenticated: authenticated }),
    rpc: { account: { getQuota: async () => ({ quotaSnapshots: { chat: { isUnlimitedEntitlement: false, remainingPercentage: quota } } }) } },
    createSession: async options => {
      events.push('session'); sessionOptions = options;
      return { on: (type, handler) => handlers.set(type, handler), sendAndWait: async input => {
        events.push('send'); handlers.get('assistant.usage')?.({ data: { model: 'fixture', inputTokens: 10, outputTokens: 5, finishReason } });
        return { data: { content: text } };
      } };
    },
  };
  return { create: options => { clientOptions = options; return client; }, events, options: () => ({ clientOptions, sessionOptions }) };
}
test('read-only preflight creates no model session and waits on auth or quota', async () => {
  for (const [setup, status] of [[{}, 'READY'], [{ authenticated: false }, 'WAIT_AUTH'], [{ quota: 0 }, 'WAIT_QUOTA'], [{ quota: NaN }, 'WAIT_QUOTA']]) {
    const f = fixture(setup); assert.deepEqual(await releaseNotes('preflight', '', 'fixture-token', f.create), { status });
    assert.deepEqual(f.events, ['start', 'stop']);
  }
});
test('SDK content call has no tools, agents, discovery or retained session and returns measured usage', async () => {
  const f = fixture(), result = await releaseNotes('generate', '{"prompt":"离线输入"}', 'fixture-token', f.create);
  assert.deepEqual(result, { status: 'RETURNED', text: '{"items":[]}', model: 'fixture', usage: { inputTokens: 10, outputTokens: 5 } });
  const { clientOptions: c, sessionOptions: s } = f.options();
  assert.equal(c.mode, 'empty'); assert.equal(c.useLoggedInUser, false); assert.equal(c.gitHubToken, 'fixture-token');
  assert.deepEqual(s.availableTools, []); assert.deepEqual(s.tools, []); assert.deepEqual(s.customAgents, []); assert.deepEqual(s.mcpServers, {});
  assert.equal(s.enableConfigDiscovery, false); assert.deepEqual(s.onPermissionRequest(), { kind: 'reject' }); assert.deepEqual(s.memory, { enabled: false });
  assert.deepEqual(f.events, ['start', 'session', 'send', 'stop']);
});
test('SDK capacity and output limits are explicit and always stop the client', async () => {
  for (const [setup, code] of [[{ finishReason: 'length' }, 'CONTENT_CAPACITY'], [{ text: '中'.repeat(5000) }, 'CONTENT_OUTPUT_LIMIT']]) {
    const f = fixture(setup); await assert.rejects(releaseNotes('generate', '{}', 'fixture-token', f.create), new RegExp(code)); assert.equal(f.events.at(-1), 'stop');
  }
});
test('oversized input never constructs the SDK client', async () => {
  const f = fixture(); await assert.rejects(releaseNotes('generate', 'x'.repeat(24 * 1024 + 1), 'fixture-token', f.create), /CONTENT_INPUT_LIMIT/);
  assert.deepEqual(f.events, []);
});
