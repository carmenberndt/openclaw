import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { publishSqliteDatabaseSchemaChange } from "./sqlite-database-admission.js";
import type { SqliteSchemaFacts } from "./sqlite-schema-admission.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type SchemaScope = { key?: string; revision: number; users: number };
export type SqliteSchemaScopeOwner = { scope?: SchemaScope; scopeRevision?: number };

const scopes = resolveGlobalSingleton(Symbol.for("openclaw.sqliteSchemaScopes"), () => {
  const byIdentity = new Map<string, SchemaScope>();
  const release = (scope: SchemaScope) => {
    scope.users -= 1;
    if (scope.users === 0 && scope.key && byIdentity.get(scope.key) === scope) {
      byIdentity.delete(scope.key);
    }
  };
  return { byIdentity, release, finalizer: new FinalizationRegistry(release) };
});

export function bindSqliteSchemaScope(
  database: DatabaseSync,
  owner: SqliteSchemaScopeOwner,
): SchemaScope {
  if (owner.scope) {
    return owner.scope;
  }
  const location = database.location();
  const key = location ? readDatabasePathIdentitySync(location).key : undefined;
  const scope = (key && scopes.byIdentity.get(key)) || { key, revision: 0, users: 0 };
  if (key) {
    scopes.byIdentity.set(key, scope);
  }
  scope.users += 1;
  owner.scope = scope;
  owner.scopeRevision = scope.revision;
  scopes.finalizer.register(database, scope, owner);
  return scope;
}

export function releaseSqliteSchemaScope(owner: SqliteSchemaScopeOwner): void {
  if (owner.scope) {
    scopes.finalizer.unregister(owner);
    scopes.release(owner.scope);
    owner.scope = undefined;
    owner.scopeRevision = undefined;
  }
}

export function publishSqliteSchemaChange(
  database: DatabaseSync,
  owner: SqliteSchemaScopeOwner,
): void {
  publishSqliteDatabaseSchemaChange(database);
  const scope = bindSqliteSchemaScope(database, owner);
  scope.revision += 1;
  owner.scopeRevision = scope.revision;
}

export type SqliteReadOperationRevision = {
  schema: SqliteSchemaFacts;
  dataVersion: number;
  mutationRevision: number;
};

export type SqliteReadScopeRevision = Readonly<
  SqliteReadOperationRevision & {
    snapshot: object | undefined;
  }
>;
