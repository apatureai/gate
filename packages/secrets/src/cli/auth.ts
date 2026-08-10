#!/usr/bin/env node
import { runAuthCli } from "./auth-cli.js";

/**
 * `gate auth` bin. All behaviour lives in runAuthCli (testable, no
 * process exit); this file is only the entrypoint the package `bin` points at.
 */
process.exitCode = await runAuthCli(process.argv.slice(2));
