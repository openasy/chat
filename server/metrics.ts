// Prometheus text exposition, written by hand: a few lines, no client library needed.
const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  channels: number;
  apps: number;
  guests: number;
  holds: number;
  /** Whether the last sync with the Matrix server worked, or null before the first. */
  syncOk: boolean | null;
  /** 1 when the chat file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="chat",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_chat_channels Channels in the chat file.",
    "# TYPE openasy_chat_channels gauge",
    `openasy_chat_channels ${g.channels}`,
    "# HELP openasy_chat_apps Apps in the chat file.",
    "# TYPE openasy_chat_apps gauge",
    `openasy_chat_apps ${g.apps}`,
    "# HELP openasy_chat_guests Guests whose access has not ended.",
    "# TYPE openasy_chat_guests gauge",
    `openasy_chat_guests ${g.guests}`,
    "# HELP openasy_chat_legal_holds Legal holds not released.",
    "# TYPE openasy_chat_legal_holds gauge",
    `openasy_chat_legal_holds ${g.holds}`,
    "# HELP openasy_chat_sync_ok 1 when the Matrix server was last brought in step with the file, 0 when that failed.",
    "# TYPE openasy_chat_sync_ok gauge",
    ...(g.syncOk === null ? [] : [`openasy_chat_sync_ok ${g.syncOk ? 1 : 0}`]),
    "# HELP openasy_chat_config_error 1 when the chat file could not be applied and its last good version is in use.",
    "# TYPE openasy_chat_config_error gauge",
    `openasy_chat_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
