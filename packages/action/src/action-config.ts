import { CONFIG_FILENAME, loadDesignReviewConfig } from "@gate/config";
import type { GateMode, NormalizedDesignReviewConfig } from "@gate/types";

/**
 * The config a run actually uses: the repository's `.gate.yml` with the
 * workflow's `gate-mode` input applied on top.
 *
 * Deliberately one function rather than a load followed by a separate override
 * in the entrypoint. The override is the only thing that can turn a review into
 * a merge gate, and an entrypoint that reads the file but forgets to apply it
 * fails nothing and looks exactly like a repository that never asked to block.
 * Putting both in the function that produces the config means the wiring cannot
 * be dropped without the config going with it.
 */

/**
 * The accepted `gate-mode` values, named here so the refusal message can list
 * them. Pinned against `.gate.yml`'s own enum by `test/gate-mode-input.test.ts`,
 * so this list cannot drift from what the schema accepts.
 */
export const GATE_MODES = ["none", "nits", "blockers"] as const satisfies readonly GateMode[];

/** Longest `gate-mode` value echoed back to the operator. */
const SHOWN_VALUE_LIMIT = 40;

/** One line of the bad value, safe to put in a log line and a Check Run summary. */
function showValue(value: string): string {
  const flattened = value.replace(/[\p{Cc}\p{Cf}`]/gu, " ");
  return flattened.length > SHOWN_VALUE_LIMIT ? `${flattened.slice(0, SHOWN_VALUE_LIMIT)}...` : flattened;
}

/** The gate mode this text names, or null when it names none of them. */
function parseGateMode(value: string): GateMode | null {
  return GATE_MODES.find((mode) => mode === value) ?? null;
}

/**
 * Thrown when the workflow set `gate-mode` to something that is not a gate
 * mode. Refusing is the point: the alternative, and what this replaced, was a
 * cast that let the typo through to a comparison it could never satisfy, so a
 * repository that typed `gate-mode: blocker` got a check that never failed and
 * never said why.
 */
export class GateModeInputError extends Error {
  readonly value: string;

  constructor(value: string) {
    super(
      `gate-mode is set to "${showValue(value)}", which is not a gate mode. ` +
        `Use one of: ${GATE_MODES.join(", ")}. ` +
        `Leave the input unset to keep the rules.gate value from ${CONFIG_FILENAME}.`,
    );
    this.name = "GateModeInputError";
    this.value = value;
  }
}

export interface ActionConfigInputs {
  /** The workflow's `gate-mode` input. Empty/absent means "do not override". */
  gateMode?: string | null;
}

/**
 * Load `.gate.yml` and apply the workflow's `gate-mode` override.
 *
 * An unset (or blank) `gate-mode` leaves `rules.gate` exactly as the file wrote
 * it. That is the whole reason `action.yml` gives the input NO default: with
 * `default: "none"` the input is never blank, so every run overrode the file
 * with `none`, and a repository that had opted into `rules.gate: blockers` in
 * `.gate.yml` silently got an advisory check instead of the merge gate it asked
 * for.
 *
 * Throws `ConfigValidationError` for an invalid file and `GateModeInputError`
 * for an invalid input; the entrypoint publishes either as a setup-failure
 * Check Run, which is neutral and says which one it was.
 */
export function resolveActionConfig(
  configText: string | null,
  inputs: ActionConfigInputs = {},
): NormalizedDesignReviewConfig {
  const config = loadDesignReviewConfig(configText);
  const raw = inputs.gateMode?.trim() ?? "";
  if (raw === "") return config;
  const mode = parseGateMode(raw);
  if (mode === null) throw new GateModeInputError(raw);
  config.rules.gate = mode;
  return config;
}
