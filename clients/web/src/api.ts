import { isRecord, isRefreshResult, isTelemetry } from "./api-validation";

export interface GridReading {
  status: "online" | "offline" | "unknown";
  evidence: Array<string>;
  confidence: "confirmed" | "unverified";
  voltageV: number | null;
  frequencyHz: number | null;
  powerW: number | null;
}

export interface BatteryReading {
  socPercent: number | null;
  powerW: number | null;
  mode: "charging" | "discharging" | "idle" | "unknown";
}

export interface Telemetry {
  source: string;
  grid: GridReading;
  battery: BatteryReading;
  home: { powerW: number | null };
  measuredAt: string | null;
  fetchedAt: string;
  freshness: { status: "fresh" | "stale" | "unavailable"; ageSeconds: number | null };
}

export interface RefreshResult {
  refresh?: { outcome?: string; reason?: string };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const bearerToken = import.meta.env.VITE_API_BEARER_TOKEN?.trim() ?? "";
const refreshToken = import.meta.env.VITE_REFRESH_TOKEN?.trim() ?? "";

export function configurationIssue(needsRefresh = false): string | null {
  if (!import.meta.env.DEV) {
    return null;
  }
  if (!bearerToken) {
    return "Set VITE_API_BEARER_TOKEN in clients/web/.env.local to connect.";
  }
  if (needsRefresh && !refreshToken) {
    return "Set VITE_REFRESH_TOKEN in clients/web/.env.local to enable refresh.";
  }
  return null;
}

async function request<T>(
  path: string,
  validate: (value: unknown) => value is T,
  init: RequestInit = {},
  needsRefresh = false,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (import.meta.env.DEV) {
    headers.set("Authorization", `Bearer ${bearerToken}`);
    if (needsRefresh) {
      headers.set("X-Refresh-Token", refreshToken);
    }
  }

  let response: Response;
  try {
    response = await fetch(`/api/v1/${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Could not reach the server. Check the server URL and your connection.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(`The server returned an unreadable response (${response.status}).`);
  }

  if (!isRecord(payload)) {
    throw new ApiError(`The server returned an invalid response (${response.status}).`);
  }
  if (!response.ok || payload.ok !== true) {
    const error = isRecord(payload.error) ? payload.error : {};
    throw new ApiError(
      typeof error.message === "string" ? error.message : `The server returned an error (${response.status}).`,
      typeof error.code === "string" ? error.code : undefined,
    );
  }

  if (!validate(payload.data)) {
    throw new ApiError(`The server returned invalid data (${response.status}).`);
  }
  return payload.data;
}

export function readTelemetry(): Promise<Telemetry | null> {
  return request("telemetry", isTelemetry);
}

export async function refreshTelemetry(): Promise<{
  telemetry: Telemetry | null;
  warning: string | null;
}> {
  let warning: string | null = null;

  try {
    const result = await request("refresh", isRefreshResult, { method: "POST" }, true);
    if (result.refresh?.outcome === "skipped" && result.refresh.reason === "data_recent") {
      warning = "The server fetched data recently, so refresh was skipped. Showing the latest stored readings.";
    }
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.code === "REFRESH_THROTTLED" || error.code === "REFRESH_IN_PROGRESS")
    ) {
      warning = `${error.message}. Showing the latest stored readings.`;
    } else {
      throw error;
    }
  }

  return { telemetry: await readTelemetry(), warning };
}
