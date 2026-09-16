/**
 * @file ndjson.mjs
 * @description Chunk-Safe Incremental UTF-8 NDJSON Line Parser.
 * 
 * DESIGN INVARIANTS:
 * 1. An upstream NDJSON stream is NOT SSE ("data: ..."). It is raw JSON per line.
 * 2. UTF-8 code points and JSON lines can split across arbitrary TCP byte boundaries.
 * 3. Handles CRLF (\r\n) and naked LF (\n) identically.
 * 4. Yields trailing complete line without newline at stream EOF.
 * 5. Memory guard: rejects lines exceeding 8MB to prevent OOM DOS attacks.
 */

import { BridgeHttpError } from '../types.mjs';

/**
 * Parses an async iterable byte stream into parsed JSON objects line-by-line.
 * 
 * @param {AsyncIterable<Uint8Array | Buffer>} stream
 * @param {Object} [options]
 * @param {number} [options.maxLineBytes=8388608] 8 MiB max line size
 * @yields {Record<string, any>}
 */
export async function* parseNdjsonStream(stream, { maxLineBytes = 8 * 1024 * 1024 } = {}) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let bufferedBytes = 0;

  for await (const chunk of stream) {
    bufferedBytes += chunk.byteLength;
    if (bufferedBytes > maxLineBytes && !buffer.includes('\n')) {
      throw new BridgeHttpError(502, 'upstream_line_too_large', 'NDJSON line exceeded maximum buffer limit.');
    }

    buffer += decoder.decode(chunk, { stream: true });

    for (;;) {
      const nlIndex = buffer.indexOf('\n');
      if (nlIndex < 0) break;

      let line = buffer.slice(0, nlIndex);
      buffer = buffer.slice(nlIndex + 1);
      bufferedBytes = Buffer.byteLength(buffer);

      if (line.endsWith('\r')) line = line.slice(0, -1);
      line = line.trim();
      if (!line) continue; // Skip empty lines

      try {
        yield JSON.parse(line);
      } catch (err) {
        throw new BridgeHttpError(502, 'invalid_upstream_json', `Failed to parse upstream NDJSON line: ${err.message}`);
      }
    }
  }

  // Flush remaining bytes in decoder
  buffer += decoder.decode();
  if (buffer.trim()) {
    let line = buffer.trim();
    if (line.endsWith('\r')) line = line.slice(0, -1);
    try {
      yield JSON.parse(line);
    } catch (err) {
      throw new BridgeHttpError(502, 'truncated_upstream_json', `Truncated trailing NDJSON line: ${err.message}`);
    }
  }
}
