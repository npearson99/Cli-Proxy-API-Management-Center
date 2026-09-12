/**
 * Claude quota read from the rate-limit headers CPA has already harvested, at no
 * upstream cost.
 *
 * Every served request answers with `Anthropic-Ratelimit-Unified-*` headers, and
 * CPA files the newest set per credential per model onto `auth-files` as
 * `model_quotas[model].signals`. Those carry the same measurement
 * `/api/oauth/usage` returns — compared across fourteen seats the two agreed
 * within one point on every window — but they cost nothing, because the request
 * that produced them is one the fleet was making anyway. Fetching usage live for
 * a page of cards is what trips Anthropic's limiter; this path sends nothing.
 *
 * What it cannot do is date itself forward: a seat that has not served since
 * Tuesday reports Tuesday's numbers. `observedAtMs` carries that age so a card
 * can say how old it is, and an explicit refresh still goes to the network.
 *
 * React-free / SCSS-free, like the sibling `data.ts` — tests/claudeQuotaSignals
 * .test.ts consumes it directly.
 */

import type { TFunction } from 'i18next';
import type { AuthFileItem, ClaudeQuotaWindow } from '@/types';
import {
  CLAUDE_ACCOUNT_WIDE_WINDOW_ID,
  CLAUDE_FABLE_WINDOW_ID,
  CLAUDE_FABLE_WINDOW_LABEL_KEY,
  WEEKLY_PERIOD_HOURS,
  formatUnixSeconds,
} from '@/utils/quota';

const SIGNAL_PREFIX = 'Anthropic-Ratelimit-Unified-';

/** The scoped weekly claim. Named for the claim, not for any model — see SCOPED_WEEKLY. */
const SCOPED_WEEKLY_CLAIM = '7d_oi';

interface ClaimSpec {
  /** Claim segment as it appears between the prefix and `-Utilization`. */
  claim: string;
  id: string;
  labelKey: string;
  periodHours: number;
}

/** Claims that describe the whole seat, so any model's entry reports them alike. */
const ACCOUNT_WIDE_CLAIMS: readonly ClaimSpec[] = [
  { claim: '5h', id: 'five-hour', labelKey: 'claude_quota.five_hour', periodHours: 5 },
  {
    claim: '7d',
    id: CLAUDE_ACCOUNT_WIDE_WINDOW_ID,
    labelKey: 'claude_quota.seven_day',
    periodHours: WEEKLY_PERIOD_HOURS,
  },
];

/**
 * Where a model's own weekly claim renders.
 *
 * The header names the claim (`7d_oi`) and never the model; only the
 * `model_quotas` key it is filed under says which model the claim is about. So
 * the attribution is by key, not by a hardcoded window: the day Anthropic scopes
 * a weekly limit to another model, it lands under that model's key and gets its
 * own row here rather than being mistaken for Fable's.
 */
const SCOPED_WEEKLY: readonly { matches: (model: string) => boolean; spec: ClaimSpec }[] = [
  {
    matches: (model) => model.startsWith('claude-fable-5'),
    spec: {
      claim: SCOPED_WEEKLY_CLAIM,
      id: CLAUDE_FABLE_WINDOW_ID,
      labelKey: CLAUDE_FABLE_WINDOW_LABEL_KEY,
      periodHours: WEEKLY_PERIOD_HOURS,
    },
  },
];

/**
 * Row order on the card, taken from the claim tables rather than from Map
 * insertion, so the rows read the same whichever model happened to be observed
 * first — and a claim added to SCOPED_WEEKLY lands after the account-wide rows
 * instead of ahead of them, which an id missing from the list would do.
 */
const WINDOW_ORDER: readonly string[] = [
  ...ACCOUNT_WIDE_CLAIMS.map((spec) => spec.id),
  ...SCOPED_WEEKLY.map(({ spec }) => spec.id),
];

interface ModelQuotaEntry {
  observed_at?: unknown;
  signals?: Record<string, unknown>;
}

/** One window's reading, tagged with when it was observed so the freshest wins. */
interface Reading {
  spec: ClaimSpec;
  usedPercent: number;
  /** Epoch seconds, the unit the header states, or null when it dates nothing. */
  resetSeconds: number | null;
  observedAtMs: number;
}

/** Past this, a value is not an instant at all — `new Date` reports it invalid. */
const MAX_EPOCH_SECONDS = 8.64e15 / 1000;

const asSignalNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const observedAtMs = (entry: ModelQuotaEntry): number | null => {
  const raw = entry.observed_at;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The headers report utilization as a fraction and the reset as epoch seconds,
 * where `/api/oauth/usage` reports a percentage and an ISO instant. Converting
 * here rather than at the call site keeps every window in the one shape the rest
 * of the quota feature already reads, whichever source built it.
 *
 * A reset that is not a usable instant is dropped rather than carried: this runs
 * inside the page's seeding effect, where one credential's malformed header
 * costs the whole grid rather than one row.
 */
const readClaim = (
  signals: Record<string, unknown>,
  spec: ClaimSpec,
  observed: number
): Reading | null => {
  const fraction = asSignalNumber(signals[`${SIGNAL_PREFIX}${spec.claim}-Utilization`]);
  if (fraction === null) return null;
  const reset = asSignalNumber(signals[`${SIGNAL_PREFIX}${spec.claim}-Reset`]);
  return {
    spec,
    usedPercent: fraction * 100,
    resetSeconds: reset !== null && reset > 0 && reset <= MAX_EPOCH_SECONDS ? reset : null,
    observedAtMs: observed,
  };
};

const modelQuotasOf = (file: AuthFileItem): Record<string, ModelQuotaEntry> => {
  const raw = file['model_quotas'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, ModelQuotaEntry>;
};

export interface ClaudeSignalQuota {
  windows: ClaudeQuotaWindow[];
  /** Newest observation behind any window, so a card can show the age of the whole set. */
  observedAtMs: number;
}

/**
 * Build the card's windows from `model_quotas`, or null when the seat has never
 * served and so has no headers to read.
 *
 * Per window the newest observation wins: an account-wide claim is reported
 * identically by every model, so the model that served most recently carries the
 * truest copy, and a model nobody has run in a week must not overwrite it.
 */
export const buildClaudeQuotaFromSignals = (
  file: AuthFileItem,
  t: TFunction,
  nowMs: number = Date.now()
): ClaudeSignalQuota | null => {
  const best = new Map<string, Reading>();

  for (const [model, entry] of Object.entries(modelQuotasOf(file))) {
    if (!entry || typeof entry !== 'object') continue;
    const signals = entry.signals;
    if (!signals || typeof signals !== 'object' || Array.isArray(signals)) continue;
    const observed = observedAtMs(entry);
    if (observed === null) continue;

    const specs: ClaimSpec[] = [...ACCOUNT_WIDE_CLAIMS];
    for (const scoped of SCOPED_WEEKLY) {
      if (scoped.matches(model)) specs.push(scoped.spec);
    }

    for (const spec of specs) {
      const reading = readClaim(signals as Record<string, unknown>, spec, observed);
      if (!reading) continue;
      const current = best.get(spec.id);
      if (!current || reading.observedAtMs > current.observedAtMs) best.set(spec.id, reading);
    }
  }

  if (best.size === 0) return null;

  const readings = [...best.values()].sort(
    (a, b) => WINDOW_ORDER.indexOf(a.spec.id) - WINDOW_ORDER.indexOf(b.spec.id)
  );

  return {
    windows: readings.map(({ spec, usedPercent, resetSeconds }) => {
      const resetAtMs = resetSeconds === null ? null : resetSeconds * 1000;
      return {
        id: spec.id,
        label: t(spec.labelKey),
        labelKey: spec.labelKey,
        // A reading describes the window it was taken in, and a window past its own
        // reset has rolled over since — most visibly the 5-hour one, which turns over
        // several times in a day an idle seat spends not reporting. Carrying the old
        // number forward would state a busy seat as busy long after it emptied, so
        // the row stays (its reset label already says how long ago that was) and only
        // the figure reads unknown. The row this cannot touch is one Anthropic dated
        // `null`, which is an idle window nobody has opened rather than a lapsed one.
        usedPercent: resetAtMs !== null && resetAtMs <= nowMs ? null : usedPercent,
        resetLabel: formatUnixSeconds(resetSeconds),
        resetAtMs,
        periodHours: spec.periodHours,
      };
    }),
    observedAtMs: Math.max(...readings.map((reading) => reading.observedAtMs)),
  };
};
