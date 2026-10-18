/**
 * @adg/trajectory — framework-free trajectory projection.
 *
 * `buildTrajectory(events, live)` turns protocol events into turns, steps and
 * records with request timing (TTFT, decode, throughput) and token usage;
 * `timeline.ts` maps records onto the overview's time axis.
 */
export * from './model.ts'
export { buildTrajectory, previewText, type BuildOptions, type LiveAttemptView } from './build.ts'
export * from './timeline.ts'
export * from './format.ts'
