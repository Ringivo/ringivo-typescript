import { describe, expect, it } from "vitest";
import { Ringivo } from "./index.js";

describe("Ringivo", () => {
  it("stores baseUrl", () => {
    const client = new Ringivo({
      baseUrl: "https://api.ringivo.com/",
      clientId: "id",
      clientSecret: "secret",
    });
    expect(client.baseUrl).toBe("https://api.ringivo.com");
  });

  it("throws on empty baseUrl", () => {
    expect(
      () => new Ringivo({ baseUrl: "", clientId: "id", clientSecret: "secret" })
    ).toThrow("baseUrl is required");
  });
});
