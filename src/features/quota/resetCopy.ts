/**
 * The words around a quota reset: the button, the confirmation, and the notices.
 *
 * Both hosts (the quota page and the auth-file cards) offer the same reset, so the
 * copy is decided once here, per provider. A provider without `describeReset` gets
 * its own `reset_*` keys with the file name, which is exactly what Codex always had;
 * Claude names the grant it is about to spend, because a seat can hold several.
 *
 * React-free — tests/claudeResets.test.ts consumes it directly.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem } from '@/types';
import type { QuotaAdapter, QuotaCardState } from './providers';
import type { QuotaResetDescription } from './providers/types';

export const resetButtonLabel = (adapter: QuotaAdapter, t: TFunction): string =>
  t(`${adapter.i18nPrefix}.reset_button`);

/** The confirmation to show, or null when there is nothing to spend. */
export function buildResetConfirmation(
  adapter: QuotaAdapter,
  file: AuthFileItem,
  quota: QuotaCardState | undefined,
  t: TFunction
): QuotaResetDescription | null {
  if (adapter.describeReset) {
    return quota ? adapter.describeReset(file, quota, t) : null;
  }
  const prefix = adapter.i18nPrefix;
  return {
    title: t(`${prefix}.reset_confirm_title`),
    message: t(`${prefix}.reset_confirm_message`, { name: file.name }),
    confirmText: t(`${prefix}.reset_confirm_button`),
  };
}

export const resetSuccessNotice = (
  adapter: QuotaAdapter,
  file: AuthFileItem,
  data: unknown,
  t: TFunction
): string =>
  adapter.describeResetSuccess?.(file, data, t) ??
  t(`${adapter.i18nPrefix}.reset_success`, { name: file.name });

export const resetFailedNotice = (
  adapter: QuotaAdapter,
  file: AuthFileItem,
  message: string,
  t: TFunction
): string => t(`${adapter.i18nPrefix}.reset_failed`, { name: file.name, message });
