import { isDeepStrictEqual } from 'node:util';
import { OperationQueue } from '../lib/operation-queue.js';
import { samePullRequestExecutionBinding } from '../domain/pull-request-execution-binding.js';
import { approveOwnPrAction } from './automatic-own-pr-repair-authorization.js';

const sameLogin = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const STALE_TARGET = Symbol('stale local code target');
const ACTIVE = new Set(['queued', 'working', 'dispatch_pending', 'waiting_external', 'waiting_condition']);
const OPERATIONS = { developer: new Set(['inspect', 'modify', 'verify']), tester: new Set(['inspect', 'verify']) };

// Routine local work has no external Review provenance. Its authorization
// cannot be used as a Review-repair or conflict-publication receipt.
export class AutomaticLocalCodeAuthorization {
  #operations = new OperationQueue();

  constructor({ specialized, configurationReader, ledger, github, confirmations, grantVerifier, objectSync, roleStateReader }) {
    Object.assign(this, { specialized, configurationReader, ledger, github, confirmations, grantVerifier, objectSync, roleStateReader });
  }

  approveCodeJob(item) {
    return this.#operations.enqueue(async () => {
      const specialized = await this.specialized.approveCodeJob(item);
      if (specialized.status !== 'pending' || specialized.kind !== 'local.code-job-create') return specialized;
      const grant = specialized.display?.payload?.action?.grant;
      const role = specialized.requestedBy?.roleId;
      if (!grant?.inputBinding || Object.hasOwn(grant, 'executionSource') || !OPERATIONS[role]?.has(grant.operation)) return specialized;
      const current = await this.#current(specialized, grant);
      if (!current) return specialized;
      if (current === STALE_TARGET) return this.#invalidate(specialized);
      await this.objectSync.prepare({ configuration: current, inputBinding: grant.inputBinding });
      const rechecked = await this.#current(specialized, grant);
      if (!rechecked) return specialized;
      if (rechecked === STALE_TARGET) return this.#invalidate(specialized);
      return approveOwnPrAction(this.confirmations, specialized);
    });
  }

  #invalidate(item) {
    return this.confirmations.invalidate(item.id, { requestedBy: item.requestedBy,
      approvalBindingDigest: item.approvalBindingDigest, reason: 'authorization_changed' });
  }

  async #current(item, grant) {
    const config = (await this.configurationReader.readActive())?.configuration;
    const actor = config?.githubActions?.actorAccountId;
    const role = item.requestedBy.roleId;
    const binding = grant.inputBinding;
    if (config?.githubActions?.enabled !== true || config.githubActions.automaticOwnPrRepair !== true ||
        !config.trackedRepositories?.includes(binding.repository) ||
        !sameLogin(binding.gitTarget?.sourceAccountId, actor)) return null;
    const roleState = await this.roleStateReader.read(role);
    if (roleState?.enabled !== true || roleState.paused !== false) return null;
    const context = await this.ledger.readPullRequestExecutionContext(binding);
    if (!samePullRequestExecutionBinding(context.inputBinding, binding)) return null;
    const root = await this.ledger.readItemForReconciliation({ itemId: binding.rootItemId });
    const task = item.requestedBy.workItemId === binding.rootItemId ? root :
      await this.ledger.readItemForReconciliation({ itemId: item.requestedBy.workItemId });
    if (!root || !task || !ACTIVE.has(root.status) || !ACTIVE.has(task.status) ||
        root.source?.scope?.active !== true || task.currentTarget?.type !== 'role' || task.currentTarget.id !== role) return null;
    const ownerRequested = root.source.scope.kind === 'owner_requested' && root.source.identity?.provider === 'local-owner';
    if (!sameLogin(context.author, actor) && !ownerRequested) return null;
    const facts = await this.github.readPullRequestLocalWorkFacts({ repository: binding.repository,
      number: binding.pullRequestNumber, account: actor, authorAccountId: context.author });
    if (facts.state !== 'open' || (context.author !== null && !sameLogin(facts.author, context.author)) ||
        facts.headRefOid !== binding.headRefOid || facts.baseRefOid !== binding.gitTarget.baseRefOid) return STALE_TARGET;
    try {
      if (!isDeepStrictEqual(await this.grantVerifier.verify(grant), grant)) return null;
    } catch (error) {
      if (error?.code === 'INVALID_CODE_JOB_AUTHORITY') return null;
      throw error;
    }
    return config;
  }
}
