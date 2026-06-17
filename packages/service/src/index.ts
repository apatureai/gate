export { buildServer } from "./app.js";
export type { BuildServerOptions } from "./app.js";

// Check Run mapping is owned by @gate/delivery (#11); re-exported here for the
// App-path service that publishes it.
export { mapCheckRunConclusion, buildCheckRun } from "@gate/delivery";
export type { CheckRunConclusion, CheckRun, CheckRunContext } from "@gate/delivery";

export {
  registerScreenshotRoute,
  stableScreenshotUrl,
  buildRunUrl,
  buildScreenshotRecords,
} from "./screenshots.js";
export type {
  ScreenshotRecord,
  ScreenshotRegistry,
  SignedUrlProvider,
  ScreenshotRouteOptions,
} from "./screenshots.js";
