// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumClient } from '@medplum/core';

// Looks up a deployed Bot by name and executes it, returning the typed result. Centralizes the
// `searchOne('Bot', { name }) -> executeBot(id, input)` pattern used across the app (e.g.
// ResourceLang2FHIRCreatePage, FaxDetailPanel) so callers get a consistent "deploy bots first" error
// when a bot is missing. Shared by the Phase 2 scribe flow and available to later phases.
export async function executeBotByName<T = unknown>(
  medplum: MedplumClient,
  name: string,
  input: unknown
): Promise<T> {
  const bot = await medplum.searchOne('Bot', { name });
  if (!bot?.id) {
    throw new Error(`Bot "${name}" not found. Deploy bots first (see Upload Data).`);
  }
  return medplum.executeBot(bot.id, input) as Promise<T>;
}
