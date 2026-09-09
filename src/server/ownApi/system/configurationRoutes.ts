/**
 * What Seyirlik is connected to, without saying how.
 *
 * The one rule this file exists to enforce: a secret that has been stored is
 * never read back out. Every integration is reported as configured or not,
 * with the facts an operator needs to recognise it — a host, a category, a
 * list of provider names — and never a key, a password or a URL carrying one.
 *
 * Configuration is read from the environment at startup and is not writable
 * over HTTP. That is deliberate rather than unfinished: the secrets file is
 * readable by the two service accounts and nothing else, and an endpoint that
 * could rewrite it would be a way to make the server fetch from somewhere new
 * with its own credentials.
 */
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import type { DatabasePool } from "../database/databasePool";
import { readSchemaState } from "../database/migrationRunner";
import { backupHealth, type BackupRepository } from "./backupRepository";

export interface IntegrationStatus {
  readonly id: string;
  readonly configured: boolean;
  /**
   * Enough to recognise which instance this is, and nothing more.
   *
   * A host and port, a category name, a count of providers. Never a key, and
   * never a URL with a query string — an indexer's URL carries its API key.
   */
  readonly detail?: string;
}

export interface ConfigurationSnapshotOptions {
  readonly pool: DatabasePool;
  /** Built at startup from the same parsers the runtime uses. */
  readonly integrations: () => IntegrationStatus[];
  readonly backups: BackupRepository;
}

export function createConfigurationRoutes({
  pool,
  integrations,
  backups,
}: ConfigurationSnapshotOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/admin/configuration",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          integrations: integrations(),
        });
      },
    },
    {
      /**
       * The schema the database is actually carrying.
       *
       * Named `seyirlik_migrations`, which is the point: the operational
       * scripts asked a table that has never existed and reported a blank
       * count as evidence for years.
       */
      method: "GET",
      path: "/admin/schema",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const state = await readSchemaState(pool);
        sendData(context.response, context.requestId, {
          applied: state.applied,
          latest: state.latest,
          current: state.current,
          pending: state.pending,
        });
      },
    },
    {
      /**
       * What the last backup actually proved.
       *
       * `healthy` is deliberately not "a file exists": it requires a run that
       * finished, carried both a dump and its configuration, and had a restore
       * rehearsed whose table count matched the live database. A panel that
       * went green on the presence of a file would read as reassurance and
       * carry none.
       */
      method: "GET",
      path: "/admin/backups",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const [latest, verified, history] = await Promise.all([
          backups.latest(),
          backups.latestVerified(),
          backups.list(20),
        ]);
        sendData(context.response, context.requestId, {
          health: backupHealth(latest),
          latest,
          latestVerified: verified,
          history,
        });
      },
    },
  ];
}

/**
 * Describes an integration without disclosing how it authenticates.
 *
 * The host is taken from a parsed URL's origin, so a base URL that happened to
 * carry a query string cannot leak one: `new URL(...).host` keeps the
 * authority and drops everything else.
 */
export function describeHost(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}
