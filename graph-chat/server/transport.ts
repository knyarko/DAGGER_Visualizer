/**
 * The real HTTP transport.
 *
 * NOTHING in this sprint calls it. Every test injects a fake `post`, and the
 * adapters take the transport as a dependency precisely so the whole model
 * path can be exercised without a key and without a network. This file exists
 * because the service is not runnable without one, and a service that can only
 * be run by writing the missing piece first is not a delivered service.
 *
 * It handles no keys. Headers are assembled by the adapter that owns the
 * provider; this function copies them onto the request and forgets them.
 */

import type { HttpPost } from './types.js';

/**
 * `fetch`-based POST with a timeout. Returns the status and the body as text,
 * and lets the adapter decide what a non-2xx means - an HTTP error is data
 * here, not an exception.
 */
export const fetchPost: HttpPost = async (url, headers, body, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};
