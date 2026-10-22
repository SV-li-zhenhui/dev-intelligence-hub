import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomaticLocalCodeAuthorization } from '../src/services/automatic-local-code-authorization.js';

function fixture(role = 'developer', operation = 'modify') {
  const binding = { schemaVersion: 2, kind: 'pull_request', repository: 'acme/repo', pullRequestNumber: 42,
    rootItemId: 'root', workKey: 'pr-work-42', inputRevision: 1, headRevision: 1,
    headRefOid: '1'.repeat(40), eventId: 'event', eventDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
    gitTarget: { schemaVersion: 1, provider: 'github', sourceAccountId: 'me', baseRepository: 'acme/repo',
      baseRefName: 'main', baseRefOid: '2'.repeat(40), headRepository: 'acme/repo', headRefName: 'fix', headRefOid: '1'.repeat(40) } };
  const grant = { inputBinding: binding, operation, allowedActions: ['read_text', 'complete'], requiredProfiles: ['fixed'] };
  const item = { id: 'confirmation-42', kind: 'local.code-job-create', status: 'pending', queueRevision: 3, itemRevision: 1,
    approvalBindingDigest: 'a'.repeat(64), displayedPayloadDigest: 'b'.repeat(64), requestedBy: { roleId: role, workItemId: 'root' },
    display: { payload: { action: { grant } } } };
  const config = { githubActions: { enabled: true, automaticOwnPrRepair: true, actorAccountId: 'me' }, trackedRepositories: ['acme/repo'] };
  const root = { status: 'waiting_external', currentTarget: { type: 'role', id: role }, source: { scope: { active: true } },
    event: { eventType: 'pull_request.status', payload: { relation: 'authored', nextAction: 'wait_review' } } };
  const facts = { state: 'open', isDraft: false, author: 'me', headRefOid: binding.headRefOid, baseRefOid: binding.gitTarget.baseRefOid };
  const roleState = { enabled: true, paused: false };
  const calls = [];
  const ports = { specialized: { async approveCodeJob(value) { return value; } },
    configurationReader: { async readActive() { return { configuration: config }; } },
    ledger: { async readPullRequestExecutionContext() { return { inputBinding: binding, author: facts.author }; },
      async readItemForReconciliation() { return root; } },
    github: { async readPullRequestLocalWorkFacts() { return facts; } },
    confirmations: { async approve(id, request) { calls.push({ id, request }); return { ...item, status: 'completed' }; },
      async invalidate(id, request) { assert.equal(id, item.id); assert.equal(request.reason, 'authorization_changed');
        assert.deepEqual(request.requestedBy, item.requestedBy); assert.equal(request.approvalBindingDigest, item.approvalBindingDigest);
        return { ...item, status: 'stale' }; } },
    grantVerifier: { async verify(value) { return value; } }, objectSync: { async prepare() {} },
    roleStateReader: { async read() { return roleState; } } };
  return { config, root, facts, roleState, ports, item, grant, calls, service: new AutomaticLocalCodeAuthorization(ports) };
}

for (const [role, operation] of [['developer', 'modify'], ['developer', 'inspect'], ['developer', 'verify'], ['tester', 'inspect'], ['tester', 'verify']]) {
  test(`automatic own-PR routine ${role} ${operation} uses the existing grant without user confirmation`, async () => {
    const f = fixture(role, operation);
    assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
    assert.equal(f.calls.length, 1);
    assert.match(f.calls[0].request.requestId, /^auto-own-pr-repair-v1-/);
    assert.equal(Object.hasOwn(f.grant, 'executionSource'), false, 'local authorization never fabricates publication provenance');
  });
}

for (const [name, mutate] of [
  ['disabled automation', f => { f.config.githubActions.automaticOwnPrRepair = false; }],
  ['external author', f => { f.facts.author = 'other'; }],
  ['changed Head', f => { f.facts.headRefOid = '9'.repeat(40); }],
  ['changed Base', f => { f.facts.baseRefOid = '9'.repeat(40); }],
  ['closed PR', f => { f.facts.state = 'closed'; }],
  ['paused task', f => { f.root.status = 'paused'; }],
  ['paused role', f => { f.roleState.paused = true; }],
  ['revoked scope', f => { f.root.source.scope.active = false; }],
  ['changed role', f => { f.root.currentTarget.id = 'orchestrator'; }],
  ['revoked grant', f => { f.ports.grantVerifier.verify = async () => { throw Object.assign(new Error('revoked'), { code: 'INVALID_CODE_JOB_AUTHORITY' }); }; }],
]) {
  test(`automatic local authorization preserves ${name}`, async () => {
    const f = fixture(); mutate(f);
    assert.equal((await f.service.approveCodeJob(f.item)).status, ['changed Head', 'changed Base', 'closed PR'].includes(name) ? 'stale' : 'pending');
    assert.equal(f.calls.length, 0);
  });
}

test('automatic local work accepts an authored Draft and trusted owner intake without a legacy relation tag', async () => {
  for (const operation of ['inspect', 'modify', 'verify']) {
    const f = fixture('developer', operation);
    f.root.event = { eventType: 'pull_request.owner_requested', payload: { workType: 'general' } };
    f.facts.isDraft = true;
    assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
    assert.equal(f.calls.length, 1);
  }
});

test('an existing trusted owner-requested local task does not ask again based on PR authorship', async () => {
  const f = fixture('tester', 'verify');
  f.facts.author = 'other';
  f.root.source.scope.kind = 'owner_requested';
  f.root.source.identity = { provider: 'local-owner' };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
  assert.equal(f.calls.length, 1);
});

test('tester cannot modify; stale and rejected authorizations cannot be revived', async () => {
  const f = fixture('tester', 'modify');
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'pending');
  for (const status of ['stale', 'rejected', 'failed']) {
    f.item.status = status;
    assert.equal((await f.service.approveCodeJob(f.item)).status, status);
  }
  assert.equal(f.calls.length, 0);
});

test('legacy owner-requested work with no author uses observed PR identity and retires an obsolete Base', async () => {
  const f = fixture('tester', 'verify');
  f.root.source.scope.kind = 'owner_requested';
  f.root.source.identity = { provider: 'local-owner' };
  f.ports.ledger.readPullRequestExecutionContext = async () => ({ inputBinding: f.grant.inputBinding, author: null });
  f.facts.author = 'contributor';
  const observed = f.ports.github.readPullRequestLocalWorkFacts;
  f.ports.github.readPullRequestLocalWorkFacts = async request => {
    assert.equal(request.authorAccountId, null);
    return observed(request);
  };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'completed');
  f.calls.length = 0;
  f.facts.baseRefOid = '9'.repeat(40);
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'stale');
  assert.equal(f.calls.length, 0);
  f.root.source.scope.kind = 'automatic';
  f.ports.github.readPullRequestLocalWorkFacts = async () => assert.fail('untrusted authorless intake cannot read for authorization');
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'pending');
});

test('unknown facts defer; authority is checked again after object preparation', async () => {
  const f = fixture();
  f.ports.github.readPullRequestLocalWorkFacts = async () => { throw new Error('offline'); };
  await assert.rejects(f.service.approveCodeJob(f.item), /offline/);
  assert.equal(f.calls.length, 0);
  f.ports.github.readPullRequestLocalWorkFacts = async () => f.facts;
  f.ports.objectSync.prepare = async () => { f.roleState.paused = true; };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'pending');
  assert.equal(f.calls.length, 0);
});

test('a target change after preparation invalidates the old grant without approval', async () => {
  const f = fixture();
  f.ports.objectSync.prepare = async () => { f.facts.baseRefOid = '9'.repeat(40); };
  assert.equal((await f.service.approveCodeJob(f.item)).status, 'stale');
  assert.equal(f.calls.length, 0);
});
