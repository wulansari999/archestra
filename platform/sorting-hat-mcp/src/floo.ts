import type { FlooTravelResult } from "./types.js";

/**
 * Floo Network — routes tool calls from the Sorting Hat back to
 * the underlying MCP server once authorization succeeds.
 * Emits green flame particles in the streaming UI.
 */

const REGISTERED_SERVERS = new Set<string>();

export function registerFlooServer(serverName: string): void {
  REGISTERED_SERVERS.add(serverName);
}

export function getRegisteredServers(): string[] {
  return Array.from(REGISTERED_SERVERS);
}

export function travel(
  fromServer: string,
  toServer: string,
  _payload: Record<string, unknown>,
): FlooTravelResult {
  if (!REGISTERED_SERVERS.has(toServer)) {
    return {
      success: false,
      traceId: "",
      greenFlameParticles: false,
    };
  }

  const traceId = `floo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    success: true,
    traceId,
    greenFlameParticles: true,
  };
}
