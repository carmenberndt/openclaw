import { PluginInstanceDrainTimeoutError } from "./plugin-instance-error.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { PluginCallToken } from "./plugin-instance-owned-values.js";
import type {
  PluginInstanceDisposalResult,
  PluginInvocationInstance,
} from "./plugin-instance.types.js";

export type DisposalCleanup = {
  failures: unknown[];
  hostFailure?: { error: unknown };
  moduleCleanups: Array<() => void | Promise<void>>;
};

export class DisposalFailures extends Set<unknown> {
  private readonly hostErrors = new Set<unknown>();
  private readonly instanceErrors = new Set<unknown>();
  private readonly resourceErrors = new Set<unknown>();

  // A classifier closure created in dispose also captures its beforeCleanup callback.
  constructor(private readonly instance: PluginInvocationInstance) {
    super();
  }

  override add(error: unknown): this {
    // Late observers retain their original token after its call has returned.
    const current = pluginInstanceInvocation.getStore();
    const isHostCleanup =
      current?.instance === this.instance && PluginCallToken.isHostCleanup(current.token);
    (isHostCleanup ? this.hostErrors : this.instanceErrors).add(error);
    return super.add(error);
  }

  /** Resource cleanup failures retain custody even after their callback settles. */
  addResourceError(error: unknown): void {
    this.resourceErrors.add(error);
    this.add(error);
  }

  result(errors: readonly unknown[]): PluginInstanceDisposalResult {
    const hostCleanupErrors = [...this.hostErrors].filter(
      (error) => !this.instanceErrors.has(error),
    );
    const retainedErrors = errors.filter(
      (error) => this.resourceErrors.has(error) || error instanceof PluginInstanceDrainTimeoutError,
    );
    return {
      errors,
      ...(retainedErrors.length ? { retainedErrors } : {}),
      ...(hostCleanupErrors.length ? { hostCleanupErrors } : {}),
    };
  }
}
