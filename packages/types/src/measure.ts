import type { NormalizedDesignReviewConfig, PreviewSource } from "./config.js";
import type { MeasurementReport, ReviewCoverage } from "./review.js";

/**
 * The MEASURE-ONLY half of the Gate <-> critique-service boundary.
 *
 * WHY THIS IS A SEPARATE CONTRACT AND NOT A FLAG ON THE REVIEW ONE. A baseline
 * needs measurements and nothing else: contrast, overflow and touch-target
 * violations computed from a captured DOM, plus the routes and viewports that
 * capture covered. None of that involves a model. A review, by contrast, always
 * spends a model call, and it is the model call that costs money.
 *
 * A flag on `GateReviewRequest` would be the cheaper diff and the wrong one. The
 * review schema is deliberately additive-tolerant: a service that predates the
 * flag would STRIP it, run the full review, bill the model call, and answer with
 * a grade Gate asked it not to form. The failure would be silent and would
 * repeat on every push to every default branch. A separate endpoint cannot fail
 * that way: a service that does not implement it answers 404, which records no
 * baseline and spends nothing.
 *
 * Gate implements neither capture nor measurement, exactly as it implements
 * neither capture nor critique for a review. This package is the published
 * contract; `packages/engine` is the client for it.
 */

/** What Gate asks a critique service to capture and measure. No judgment is requested. */
export type GateMeasurementRequest = {
  installationId: string;
  repository: {
    owner: string;
    name: string;
    /** The branch this commit is on, which is the repository's default branch. */
    defaultBranch: string;
  };
  /** The commit the resulting set is filed under. Full 40-character SHA. */
  commitSha: string;
  preview: {
    /** The deployment of `commitSha` to capture. Verified by Gate before handoff. */
    url: string;
    provider: PreviewSource;
    environment: string | null;
  };
  /**
   * The repository's normalized `.gate.yml`, so routes, viewports and dark mode
   * match what a pull request against this commit will be measured with. A set
   * measured over different routes than the pull request that is compared with it
   * is the one way a baseline can quietly stop meaning anything, and this is the
   * field that keeps the two runs comparable.
   */
  config: NormalizedDesignReviewConfig;
};

/**
 * What a measure-only run returns.
 *
 * There is no `grade`, no `findings`, no `overall` and no `provenance`, and
 * their absence is the contract rather than an omission: a run that produced any
 * of them called a model, which is the one thing this request exists not to do.
 * Gate's parser REFUSES a payload carrying them rather than stripping them.
 */
export type GateMeasurementResult = {
  /**
   * The measured facts. Required, unlike on a review result: a measure-only call
   * that reports no measurement report at all has answered a different question
   * than the one it was asked, and an empty `checksRun` is the supported way to
   * say nothing was measured.
   */
  measurements: MeasurementReport;
  /**
   * What the capture covered. Optional and read exactly as on a review: a route
   * in `routesReviewed` is proof the route was captured and therefore measured
   * by whichever checks ran, and absence means "not stated", never "everything".
   *
   * `routesRequested`/`viewportsRequested` are carried unchanged from the review
   * shape so one reader serves both.
   */
  coverage?: ReviewCoverage;
  metadata: {
    engineVersion: string;
    captureVersion: string;
  };
};
