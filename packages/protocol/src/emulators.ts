/**
 * `emulators@1`: Android emulators for ADB-driven scripts — what is installed,
 * instances, which one tasks use. Served by `@adg/emulator`.
 */
import { z } from 'zod'

export const EMULATORS_CAPABILITY = 'emulators'

export const EmulatorInstance = z.object({
  index: z.number().int().min(0),
  name: z.string(),
  /** The emulator process is up. */
  running: z.boolean(),
  /** Android has finished booting. */
  ready: z.boolean(),
  adb: z.string().optional(),
})
export type EmulatorInstance = z.infer<typeof EmulatorInstance>

export const EmulatorProvider = z.object({
  kind: z.enum(['mumu']),
  name: z.string(),
  /** The manager program used for control, e.g. MuMuManager.exe. */
  manager: z.string(),
  version: z.string().optional(),
  instances: z.array(EmulatorInstance),
  error: z.string().optional(),
})
export type EmulatorProvider = z.infer<typeof EmulatorProvider>

export const EmulatorSettings = z.object({
  /** MuMuManager.exe chosen by the user; otherwise found automatically. */
  mumuManager: z.string().optional(),
  /** Instance tasks use. */
  instance: z.number().int().min(0).max(63),
  /**
   * Use this ADB address instead of managing an emulator (any emulator or
   * device the user starts themselves).
   */
  manualAddress: z.string().regex(/^[\w.-]+:\d{1,5}$/).optional(),
  /** Start the instance when a task needs it. */
  autoStart: z.boolean(),
  /** Seconds to wait for Android to finish booting. */
  bootTimeoutSeconds: z.number().int().min(30).max(900),
})
export type EmulatorSettings = z.infer<typeof EmulatorSettings>

const Status = z.object({
  providers: z.array(EmulatorProvider),
  settings: EmulatorSettings,
  /** What a task would use right now, or why it cannot. */
  selection: z.object({ label: z.string(), address: z.string().optional(), problem: z.string().optional() }),
})

export const EmulatorRequests = {
  'emulators/status': {
    capability: EMULATORS_CAPABILITY,
    params: z.object({ refresh: z.boolean().optional() }),
    result: Status,
  },
  'emulators/start': {
    capability: EMULATORS_CAPABILITY,
    params: z.object({ index: z.number().int().min(0).optional() }),
    result: z.object({ address: z.string(), label: z.string() }),
  },
  'emulators/stop': {
    capability: EMULATORS_CAPABILITY,
    params: z.object({ index: z.number().int().min(0).optional() }),
    result: z.object({}),
  },
  'emulators/settings/set': {
    capability: EMULATORS_CAPABILITY,
    params: EmulatorSettings.partial().extend({ mumuManager: z.string().nullable().optional(), manualAddress: z.string().regex(/^[\w.-]+:\d{1,5}$/).nullable().optional() }),
    result: EmulatorSettings,
  },
} as const

export const EmulatorNotifications = {
  'emulators/changed': z.object({}),
} as const
