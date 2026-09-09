/**
 * What Seyirlik is connected to, and what schema the database carries.
 *
 * Read-only on purpose. Configuration lives in the environment files the two
 * service accounts can read and nothing else can; an endpoint that could
 * rewrite it would be a way to make the server fetch from somewhere new with
 * its own credentials. So this reports state, and changing it is an operator
 * editing a protected file and restarting.
 */
import { ownApiClient } from "../api/ownApi/client";

export interface IntegrationStatus {
  readonly id: string;
  readonly configured: boolean;
  /** A host or a name — never a key. */
  readonly detail?: string;
}

export interface SchemaStatus {
  readonly applied: number;
  readonly latest: string | null;
  readonly current: boolean;
  readonly pending: string[];
}

export async function fetchIntegrations(): Promise<IntegrationStatus[]> {
  const { integrations } = await ownApiClient.request<{
    integrations: IntegrationStatus[];
  }>("/admin/configuration");
  return integrations;
}

export function fetchSchemaStatus(): Promise<SchemaStatus> {
  return ownApiClient.request<SchemaStatus>("/admin/schema");
}
