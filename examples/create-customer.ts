/**
 * Create a customer, give it a phone system, and route one of your numbers
 * to it.
 *
 *     RINGIVO_BASE_URL=https://api.yourprovider.example \
 *     RINGIVO_CLIENT_ID=... RINGIVO_CLIENT_SECRET=... RINGIVO_TENANT=... \
 *     NUMBER=+13025550100 \
 *     npx tsx examples/create-customer.ts
 *
 * NUMBER is optional: without it the script stops once the phone system is
 * built. The credential must be issued for your whole account, with the
 * scopes below.
 *
 * In your own code, import from "ringivo" rather than "../src/index.js".
 */
import { ConflictError, Ringivo, UnprocessableEntityError } from "../src/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`set ${name}`);
  }
  return value;
}

const client = new Ringivo({
  baseUrl: required("RINGIVO_BASE_URL"),
  clientId: required("RINGIVO_CLIENT_ID"),
  clientSecret: required("RINGIVO_CLIENT_SECRET"),
  tenant: required("RINGIVO_TENANT"),
  scopes: ["customers:read", "customers:write", "numbers:read", "numbers:assign", "numbers:route"],
});

async function main(): Promise<void> {
  // 1. Where this customer may be placed.
  const regions = await client.regions.list();
  const us = regions.find((region) => region.country === "US");
  if (!us) {
    throw new Error("your account cannot place a customer in the US yet");
  }
  const regionPreference = us.options[0]?.value ?? "partner_default";

  // 2. The customer. An address that cannot be confirmed is a 422 on addressLines.
  let customer;
  try {
    customer = await client.customers.create({
      name: "Acme Dental",
      country: "US",
      addressLines: ["233 S Wacker Dr"],
      city: "Chicago",
      region: "IL",
      postalCode: "60606",
      timeZone: "America/Chicago",
      dataResidencyCountry: us.country,
      regionPreference,
    });
  } catch (error) {
    if (error instanceof UnprocessableEntityError) {
      for (const problem of error.errors) {
        console.error(problem.source?.pointer, problem.detail);
      }
    }
    throw error;
  }
  console.log("created", customer.id, customer.code);

  // 3. and 4. The phone system, then the wait for it to be built.
  await client.customers.enablePbx(customer.id);
  const ready = await client.customers.waitForPbx(customer.id);
  console.log("phone system", ready.provisioningState, ready.code);
  if (ready.provisioningState !== "active") {
    throw new Error("the phone system was not built: read the customer again later, or contact your provider");
  }

  // 5. and 6. One of your numbers, given to the customer and routed to its phone system.
  const e164 = process.env.NUMBER;
  if (!e164) {
    return;
  }
  const [number] = (await client.phoneNumbers.list({ e164 })).data;
  if (!number) {
    throw new Error(`${e164} is not in your inventory`);
  }
  try {
    await client.phoneNumbers.assign(number.id, customer.id);
    await client.phoneNumbers.route(number.id);
  } catch (error) {
    if (error instanceof ConflictError) {
      // `title` names the state: Already assigned, Not routable, Already routed, …
      console.error(error.errors[0]?.title, error.errors[0]?.detail);
    }
    throw error;
  }
  console.log("routed", number.e164, "to", customer.name);

  // The calls now reach the phone system; this makes the phone system know the
  // number ("Add to PBX"). It answers `pending` while the write is queued.
  const added = await client.pbxNumbers.create({ phoneNumberId: number.id });
  console.log("added to the phone system:", added.state);
  // For a call to be answered, point the number at a user or an auto
  // attendant in the phone system itself.
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
