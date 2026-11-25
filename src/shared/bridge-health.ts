/**
 * The bridge self-check's latest result per omp version on this computer, or on the paired host `device` names
 * (payload: device?; answer: BridgeHealthReport). Not in IPC_COMMANDS: no window calls it (only `ompdesk_app`
 * `omp.bridge_health` does), and IPC_COMMANDS rides in the paired phone's first-screen bundle.
 */
export const BRIDGE_HEALTH_GET = "bridge-health:get";
