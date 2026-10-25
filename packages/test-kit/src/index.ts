/**
 * @adg/test-kit — the local simulation environment.
 *
 * The development machine cannot run games, so everything that would touch a
 * real script, GitHub, an emulator or the screen has a stand-in here. Only
 * tests depend on this package; it never ships in the installer.
 */
export { parseScenario, runScenario, type Scenario, type ScenarioStep, type ScenarioIo } from './fake-script.ts'
export { startFakeGitHub, type FakeAsset, type FakeFault, type FakeGitHub, type FakeGitHubOptions, type FakeRelease } from './fake-github.ts'
export { startFakeLlm, type FakeLlm, type FakeLlmOptions, type FakeReply } from './fake-llm.ts'
export { ManualClock, type Clock } from './clock.ts'
export { makeZip, type ZipEntries } from './zip.ts'
export { startFakeFeishu, type FakeFeishu, type FakeFeishuMessage, type FakeFeishuRequest } from './fake-feishu.ts'
export { schemaProblems } from './schema-lint.ts'
