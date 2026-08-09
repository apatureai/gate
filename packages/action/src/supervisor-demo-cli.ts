import { formatSupervisorDemoReport, runSupervisorDemo } from "./supervisor-demo.js";

/**
 * `node packages/action/dist/supervisor-demo-cli.js` — runs the sandbox
 * supervisor against the local fixture app and prints what it observed. No
 * credentials, no network beyond loopback. Exit code 1 if any claim failed.
 */
const report = await runSupervisorDemo();
console.log(formatSupervisorDemoReport(report));
process.exitCode = report.ok ? 0 : 1;
