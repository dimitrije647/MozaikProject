/**
 * Privacy guard for Mozaik Cloud telemetry.
 *
 * Mozaik core's `runLoop` creates a Mozaik Cloud client (`createCloudClient()` in
 * @mozaik-ai/cloud-sdk). When it finds a project key it streams every loop event to
 * app.jigjoy.ai, by default with full payloads (prompts, answers, tool output). It looks for the
 * key, in this order, in: `process.env.MOZAIK_API_KEY`, `MOZAIK_PROJECT_KEY`, a `.env` file in the
 * process working directory, and the paired-device file `~/.mozaik/credentials.json`.
 * That is far too easy to enable by accident for a product that handles customer briefs and BYOK
 * traffic, so LaunchPilot turns it off unless an operator explicitly opts in.
 *
 * How the off switch works without touching library code: the key lookup is
 * `process.env.X ?? <file fallbacks>`, and `??` only falls through on null/undefined. An EMPTY
 * `MOZAIK_API_KEY` therefore wins, the SDK finds no key and returns a disabled no-op client, and
 * neither the cwd `.env` nor the credentials file is consulted.
 *
 * Opt in with LAUNCHPILOT_MOZAIK_CLOUD=on. Even then, payloads are redacted to event types only
 * (`MOZAIK_REDACTION=all`) unless the operator chose another level.
 */
export const CLOUD_OPT_IN_ENV = 'LAUNCHPILOT_MOZAIK_CLOUD';

export type TelemetryMode = 'disabled' | 'enabled-by-operator';

export function enforceTelemetryPolicy(env: NodeJS.ProcessEnv = process.env): TelemetryMode {
  if (env[CLOUD_OPT_IN_ENV]?.toLowerCase() === 'on') {
    if (!env.MOZAIK_REDACTION) env.MOZAIK_REDACTION = 'all';
    return 'enabled-by-operator';
  }
  env.MOZAIK_API_KEY = '';
  env.MOZAIK_PROJECT_KEY = '';
  return 'disabled';
}
