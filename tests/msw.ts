/**
 * The mock transport these tests assert against, and how a call is recorded.
 *
 * -- WHY msw AND NOT undici's MockAgent --------------------------------------
 * Every test in this repository asserts the REQUEST that went out: the
 * multipart part headers, the presence or absence of a bearer, the
 * User-Agent, the escaped path. msw hands a handler a real `Request` object,
 * so `await request.clone().text()` is the exact bytes that would have gone
 * on the wire and `request.headers` is the exact header set. undici's
 * MockAgent gives an intercept a serialised `opts` bag instead, and a
 * multipart body reaches it as whatever the dispatcher happened to hold —
 * which is the one thing these tests exist to pin.
 *
 * `onUnhandledRequest: "error"` is deliberate: a request to a URL no handler
 * claimed FAILS the test instead of leaving the process to reach the real
 * network. A test that silently made a live call would be worse than a test
 * that failed.
 */
import { setupServer } from "msw/node";
import type { SetupServer } from "msw/node";
import { afterAll, afterEach, beforeAll } from "vitest";

/**
 * A server wired into this file's lifecycle. Add handlers per test with
 * `server.use(...)`; they are reset between tests.
 */
export function mockServer(): SetupServer {
  const server = setupServer();

  beforeAll(() => {
    server.listen({ onUnhandledRequest: "error" });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });

  return server;
}

/** One request as it went out, with its body already read off a clone. */
export interface Recorded {
  request: Request;
  body: string;
  url: URL;
}

/**
 * A place to collect requests, and the recorder that fills it.
 *
 * The body is read from a CLONE: reading the original would consume it
 * before msw could pass it on, and the handler still has to answer.
 */
export class Calls {
  readonly all: Recorded[] = [];

  async record(request: Request): Promise<void> {
    this.all.push({
      request,
      body: await request.clone().text(),
      url: new URL(request.url),
    });
  }

  get count(): number {
    return this.all.length;
  }

  get last(): Recorded {
    const last = this.all.at(-1);
    if (!last) {
      throw new Error("no request was recorded");
    }
    return last;
  }

  at(index: number): Recorded {
    const found = this.all[index];
    if (!found) {
      throw new Error(`no request was recorded at index ${index} (${this.all.length} recorded)`);
    }
    return found;
  }
}
