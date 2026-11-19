/**
 * The app page: one web page of yours in the menu of your customers' phone
 * apps.
 *
 *     await client.customers.setAppPage(customer.id, {
 *       url: "https://app.example.com/phone",
 *       label: "Missed calls",
 *       icon: "call_missed",
 *     });
 *
 * The calls are on the two namespaces whose ids they take:
 * `customers.setAppPage()`, `getAppPage()` and `clearAppPage()` for a
 * customer, and the same three on `pbx.subscribers` for one subscriber. This
 * module holds what the six share: the options a set takes and the body it
 * sends.
 *
 * -- ONE PAGE: AN ADDRESS, A LABEL AND AN ICON ------------------------------
 * A page is one entry in the menu of the iOS app, the Android app and the web
 * phone. It is set for a customer, or for one of its subscribers; a
 * subscriber with no page of its own gets the customer's.
 *
 * -- YOUR PAGE SIGNS ITS USERS IN ITSELF -------------------------------------
 * The apps load the address exactly as you set it and give your page nothing
 * about the user. Use your own sign-in on the page. NEVER PUT A SECRET IN THE
 * ADDRESS: anyone can read it. A value of your own in it, such as a customer
 * id, is a hint only and proves nothing about the user. To match a user who
 * signed in on your page to a phone user, read `pbx.subscribers.list()`.
 *
 * -- A SET IS A WHOLE REPLACEMENT, AND RESENT ON A TRANSIENT FAILURE ---------
 * `setAppPage()` replaces the whole page with a POST of FLAT JSON, not a
 * JSON:API document. The API says a set it already holds changes nothing, so
 * this client resends it like an update: after no answer, a 429 or a 5xx —
 * the 502 that says the phone system failed part way included, which the
 * API asks you to answer by sending the same set again. A 409 titled
 * `Change in progress` is not resent by the client, and `isRetryable()` is
 * `false` for it, because it carries no `code`: match its title and send it
 * again yourself in a moment.
 *
 * -- THE ANSWER OF A SET IS AN ECHO, NOT A READ ------------------------------
 * A set answers what was written: `complete` is always `true` there, and
 * `effective` is the page sent. A page your provider set for many customers
 * (`source` `default`) outranks a customer's page, and only `getAppPage()`
 * shows that. `clearAppPage()` is a DELETE that answers 204 also when there
 * was no page, and is resent like every DELETE.
 *
 * -- WHAT IS REFUSED --------------------------------------------------------
 * The API checks the address and the label, and this client passes them
 * through unchanged: a refused member is an `UnprocessableEntityError` whose
 * `errors[0].source.pointer` names it (`/url`, `/label`, `/icon`), and
 * nothing is written. A customer with no phone system is a `ConflictError`.
 *
 * Setting and clearing need `pbx-app-pages:write`, on a credential for your
 * whole account. Reading needs `pbx-app-pages:read`, which the write scope
 * includes.
 */
import type { components } from "./_generated/schema.js";

/** What `setAppPage()` takes, on a customer or a subscriber. */
export interface SetAppPageOptions {
  /**
   * The page's address: `https://` and a host name, at most 2,000
   * characters. The apps load it as it stands. No IP address as the host, no
   * user name or password, and no `[` or `]` (also not percent-encoded): each
   * is a 422 on `/url`, and its `detail` says why.
   */
  url: string;
  /** The text of the menu entry, 1 to 64 characters. */
  label: string;
  /**
   * A Material icon name: lower-case letters, digits and `_`. Left off the
   * request when absent, and the API then uses `open_in_new`.
   */
  icon?: string;
}

type SetRequest = components["schemas"]["AppPageSetRequest"];

/** The flat JSON body of a set, with `icon` only when it was named. */
export function appPageBody(options: SetAppPageOptions): SetRequest {
  const body: SetRequest = { url: options.url, label: options.label };
  if (options.icon !== undefined) {
    body.icon = options.icon;
  }
  return body;
}
