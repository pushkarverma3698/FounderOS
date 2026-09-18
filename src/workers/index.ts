/**
 * FounderOS — Workers Module (barrel)
 * =====================================
 * Re-exports for the worker contract architecture.
 */

// ── Contract types ───────────────────────────────────────────────────────────
export {
  type WorkerContract,
  type WorkerIdentity,
  type WorkerObjective,
  type WorkerPermissions,
  type WorkerContextRefs,
  type WorkerRuntime,
  type WorkerSchedule,
  type WorkerStatus,
  type ScheduleMode,
  type ObjectivePriority,
  WorkerContractSchema,
  WORKER_STATUSES,
  VALID_TRANSITIONS,
  SCHEDULE_MODES,
  OBJECTIVE_PRIORITIES,
} from "./contracts/types.js";

// ── Contract validation ──────────────────────────────────────────────────────
export {
  parseWorkerContract,
  validateWorkerContract,
  type ContractParseResult,
  type ContractParseSuccess,
  type ContractParseFailure,
} from "./contracts/validation.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────
export { CAREER_OPERATOR_CONTRACT } from "./contracts/career-operator.js";

// ── Capability resolution ────────────────────────────────────────────────────
export { CapabilityResolver, capabilityResolver } from "./capabilities/resolver.js";
export { DEFAULT_CAPABILITY_MAPPINGS } from "./capabilities/mappings.js";
export {
  buildWorkerToolManifest,
  type WorkerToolManifest,
  type ToolManifestEntry,
} from "./capabilities/manifest.js";
export {
  validateCapabilityMappings,
  validateWorkerCapabilities,
} from "./capabilities/validation.js";

// ── Worker context ───────────────────────────────────────────────────────────
export {
  type WorkerContext,
  type WorkerContextProvider,
  type MemoryEntry,
  DefaultWorkerContextProvider,
} from "./context/worker-context.js";

// ── Lifecycle ────────────────────────────────────────────────────────────────
export { WorkerLifecycleManager, type WorkerState } from "./lifecycle/manager.js";
export {
  InMemoryProgressStore,
  type WorkerProgressReport,
  type WorkerProgressStore,
  type ProgressStatus,
  PROGRESS_STATUSES,
} from "./lifecycle/progress.js";

// ── Runtime adapters ─────────────────────────────────────────────────────────
export {
  type WorkerRuntimeAdapter,
  type RuntimeBootstrapPacket,
  type WorkerRuntimeHandle,
  type WorkerRuntimeStatus,
  type WorkerTask,
} from "./runtimes/types.js";
export { StubRuntimeAdapter } from "./runtimes/stub.js";
