import type { RuntimePolicyOverrides, SettingsRepository } from "@jarvis/db";
import type { QuietHours } from "@jarvis/shared";

/**
 * Where the call policy actually comes from.
 *
 * The environment supplies the deployed defaults; the database may override
 * individual settings. Resolution happens per request rather than at startup,
 * so moving quiet hours takes effect on the next call instead of the next
 * deploy — which is the whole point of making these editable.
 *
 * The read is a single indexed row and calls are rare; caching it would trade a
 * negligible saving for the possibility of enforcing a policy the operator has
 * already changed.
 */

export interface PolicyDefaults {
  quietHours: QuietHours;
  maxCallsPerHour: number;
  maxCallsPerDay: number;
}

export interface ResolvedPolicy extends PolicyDefaults {
  /** Which settings come from the database rather than the environment. */
  overridden: {
    quietHoursStart: boolean;
    quietHoursEnd: boolean;
    quietHoursTimezone: boolean;
    maxCallsPerHour: boolean;
    maxCallsPerDay: boolean;
  };
  updatedAt: string | null;
}

export type PolicyPatch = Partial<Omit<RuntimePolicyOverrides, "updatedAt">>;

export class PolicyService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly defaults: PolicyDefaults,
  ) {}

  /** The deployed values, with no database overrides applied. */
  environmentDefaults(): PolicyDefaults {
    return {
      quietHours: { ...this.defaults.quietHours },
      maxCallsPerHour: this.defaults.maxCallsPerHour,
      maxCallsPerDay: this.defaults.maxCallsPerDay,
    };
  }

  async resolve(): Promise<ResolvedPolicy> {
    const overrides = await this.settings.getRuntimePolicy();
    return this.merge(overrides);
  }

  async update(patch: PolicyPatch): Promise<ResolvedPolicy> {
    return this.merge(await this.settings.updateRuntimePolicy(patch));
  }

  private merge(o: RuntimePolicyOverrides): ResolvedPolicy {
    return {
      quietHours: {
        start: o.quietHoursStart ?? this.defaults.quietHours.start,
        end: o.quietHoursEnd ?? this.defaults.quietHours.end,
        timezone: o.quietHoursTimezone ?? this.defaults.quietHours.timezone,
      },
      // `??` rather than `||`: 0 is a meaningful override — it means unlimited —
      // and would otherwise silently fall back to the environment value.
      maxCallsPerHour: o.maxCallsPerHour ?? this.defaults.maxCallsPerHour,
      maxCallsPerDay: o.maxCallsPerDay ?? this.defaults.maxCallsPerDay,
      overridden: {
        quietHoursStart: o.quietHoursStart !== null,
        quietHoursEnd: o.quietHoursEnd !== null,
        quietHoursTimezone: o.quietHoursTimezone !== null,
        maxCallsPerHour: o.maxCallsPerHour !== null,
        maxCallsPerDay: o.maxCallsPerDay !== null,
      },
      updatedAt: o.updatedAt ? o.updatedAt.toISOString() : null,
    };
  }
}
