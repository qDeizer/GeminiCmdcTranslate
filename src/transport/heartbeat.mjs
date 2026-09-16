/**
 * @file heartbeat.mjs
 * @description Anti-Stall Idle Heartbeat Watchdog.
 * 
 * DESIGN INVARIANTS:
 * 1. Deep reasoning models (DeepSeek-R1, Muse Spark) can think silently for 20-120+ seconds.
 * 2. Claude Desktop and Codex timeout after 15-30 seconds of silence if no bytes arrive.
 * 3. Sends protocol-native ping frames only when the socket is idle:
 *    - Anthropic: event: ping\ndata: {"type":"ping"}\n\n
 *    - OpenAI / Responses: : keepalive\n\n
 * 4. Resets idle timer on actual downstream writes to avoid flooding the wire.
 * 5. Backpressure-aware: skips heartbeat if res.writableNeedDrain is true.
 */

export function createHeartbeat({
  res,
  protocol = 'anthropic',
  idleIntervalMs = 12000
}) {
  let lastWrite = Date.now();
  let stopped = false;

  const pingFrame = protocol === 'anthropic'
    ? 'event: ping\ndata: {"type":"ping"}\n\n'
    : ': keepalive\n\n';

  const timer = setInterval(() => {
    if (stopped || res.destroyed || res.writableEnded) {
      clearInterval(timer);
      return;
    }

    // Skip heartbeat if client buffer is already congested
    if (res.writableNeedDrain) return;

    // Send heartbeat only if socket has been silent for idleIntervalMs
    if (Date.now() - lastWrite >= idleIntervalMs) {
      if (res.write(pingFrame)) {
        lastWrite = Date.now();
      }
    }
  }, 1000);

  // Allow Node process to exit cleanly if only heartbeat timer is alive
  if (timer.unref) timer.unref();

  return {
    touch() {
      lastWrite = Date.now();
    },
    stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
    }
  };
}
