/**
 * One page of a list, and the walk to the pages after it.
 *
 * Every `list()` in this package answers a `PagePromise`. Await it for the
 * first page; iterate it with `for await` for every item on every page:
 *
 *     const first = await client.customers.list();      // one page
 *     for await (const customer of client.customers.list()) {
 *       // every customer, page after page
 *     }
 *
 * -- ONE SHAPE FOR EVERY LIST ------------------------------------------------
 * The items are always `page.data`, the cursor always `page.nextCursor`,
 * whatever the resource, so code that walks one list walks them all. The
 * API pages every collection the same way (cursor pagination, newest first),
 * and this is that one rule, written once.
 *
 * -- THE CURSOR IS THE SERVER'S ----------------------------------------------
 * `nextCursor` is lifted out of `meta.page.nextCursor`, never built here. The
 * next page is the same query with `after` set to it, which is what the API
 * documents. It is `null` on the last page, and that null is what ends a walk.
 *
 * -- A BACKWARD READ IS ONE PAGE ---------------------------------------------
 * A list asked for with `before` (the polling read: "what arrived since this
 * cursor") is a single page. `hasNextPage()` is `false` for it, so a
 * `for await` over it reads that page and stops. To poll again, keep the
 * first item's cursor and ask again — the walk direction is yours to choose,
 * never this package's guess.
 */
import type { RawJson } from "./models.js";

/** What a list builder hands this module: the parts of one collection document. */
export interface PageParts<T> {
  readonly data: readonly T[];
  readonly nextCursor: string | null;
  readonly nextUrl: string | null;
  readonly raw: RawJson;
}

/** Reads the page after a cursor. Absent when the walk stops at this page. */
export type NextPage<T> = (cursor: string) => Promise<Page<T>>;

/** One page of a list. Iterate it with `for await` to walk this page and every page after it. */
export class Page<T> implements AsyncIterable<T> {
  /** The items on this page, in the order the API sent them. */
  readonly data: readonly T[];
  /** The cursor of the next page, or `null` on the last one. Pass it as `after`. */
  readonly nextCursor: string | null;
  /** The API's own link to the next page, or `null` on the last one. */
  readonly nextUrl: string | null;
  /**
   * The size of the whole collection, on the collections whose API answer
   * carries one (`meta.page.total`); `null` on the rest.
   */
  readonly total: number | null;
  /** The collection document exactly as it arrived. */
  readonly raw: RawJson;

  readonly #next: NextPage<T> | undefined;

  constructor(parts: PageParts<T>, next?: NextPage<T>) {
    this.data = Object.freeze([...parts.data]);
    this.nextCursor = parts.nextCursor;
    this.nextUrl = parts.nextUrl;
    this.total = totalOf(parts.raw);
    this.raw = parts.raw;
    this.#next = next;
    Object.freeze(this);
  }

  /** Whether there is a page after this one to read. */
  hasNextPage(): boolean {
    return this.nextCursor !== null && this.#next !== undefined;
  }

  /**
   * Read the page after this one.
   *
   * @throws Error when there is none — check `hasNextPage()` first.
   */
  async getNextPage(): Promise<Page<T>> {
    if (this.nextCursor === null || this.#next === undefined) {
      throw new Error("there is no next page: check hasNextPage() before getNextPage()");
    }
    return this.#next(this.nextCursor);
  }

  /** This page, then every page after it. */
  async *iterPages(): AsyncGenerator<Page<T>, void, undefined> {
    let page: Page<T> = this;
    yield page;
    while (page.hasNextPage()) {
      page = await page.getNextPage();
      yield page;
    }
  }

  /** Every item on this page and on every page after it. */
  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for await (const page of this.iterPages()) {
      yield* page.data;
    }
  }
}

/**
 * A pending first page that is also the whole walk: `await` it for the page,
 * `for await` it for every item.
 *
 * A real `Promise` (so `instanceof Promise`, `Promise.all` and `.catch` work)
 * whose `then`, `catch` and `finally` are the request's own. The request is
 * sent once, when the list method is called, whichever way it is then read.
 */
export class PagePromise<T> extends Promise<Page<T>> implements AsyncIterable<T> {
  readonly #request: Promise<Page<T>>;

  constructor(request: Promise<Page<T>>) {
    super((resolve) => {
      // The executor's own promise is never read: `then` below delegates to
      // `request`. Resolved at once so it can never be an unhandled rejection.
      resolve(undefined as unknown as Page<T>);
    });
    this.#request = request;
  }

  // `then` and friends on a derived promise return a plain Promise rather
  // than another PagePromise, which would need a request to wrap.
  static override get [Symbol.species](): PromiseConstructor {
    return Promise;
  }

  override then<R1 = Page<T>, R2 = never>(
    onfulfilled?: ((value: Page<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#request.then(onfulfilled, onrejected);
  }

  override catch<R = never>(
    onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
  ): Promise<Page<T> | R> {
    return this.#request.catch(onrejected);
  }

  override finally(onfinally?: (() => void) | null): Promise<Page<T>> {
    return this.#request.finally(onfinally);
  }

  /** Every item on every page, starting with the first. */
  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    const first = await this.#request;
    yield* first;
  }
}

/**
 * Build the `PagePromise` a list method answers.
 *
 * `read(after)` sends the query with `after` in place of the caller's own
 * (`undefined` for the first page). `backward` is true when the caller asked
 * with `before`; that read is one page, see the note at the top.
 */
export function paginate<T>(
  read: (after: string | undefined) => Promise<PageParts<T>>,
  options: { after?: string | undefined; backward?: boolean } = {},
): PagePromise<T> {
  const load = async (after: string | undefined): Promise<Page<T>> => {
    const parts = await read(after);
    return new Page(parts, options.backward ? undefined : (cursor) => load(cursor));
  };
  return new PagePromise(load(options.after));
}

function totalOf(raw: RawJson): number | null {
  const meta = raw.meta;
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const page = (meta as Record<string, unknown>).page;
  if (typeof page !== "object" || page === null) {
    return null;
  }
  const total = (page as Record<string, unknown>).total;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}
