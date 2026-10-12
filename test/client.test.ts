import { describe, expect, it } from "vitest";
import { AuthError, RejectedError, SpeedianceClient } from "../src/client.js";
import { fakeSpeediance, loginRoutes } from "./fake.js";

describe("SpeedianceClient", () => {
  it("logs in lazily, sends app headers, and caches the session", async () => {
    const { client, calls, store, settings } = fakeSpeediance({
      ...loginRoutes(),
      "GET /api/app/userinfo/info": () => ({ code: 0, data: { nickName: "Me" } }),
    });
    expect(await client.get("/api/app/userinfo/info")).toEqual({ nickName: "Me" });
    expect(calls.map((c) => c.path)).toEqual([
      "/api/app/v2/login/verifyIdentity",
      "/api/app/v2/login/byPass",
      "/api/app/userinfo/info",
    ]);
    expect(calls[0].headers.App_type).toBe("BIKE"); // login uses the bike slot by default
    expect(calls[2].headers).toMatchObject({ App_type: "SOFTWARE", Token: "tok", App_user_id: "42" });
    expect(store.load()).toMatchObject({ token: "tok", userId: "42", unit: "lb" });
    // A new client reuses the cached session without logging in.
    const again = new SpeedianceClient(settings, store, { fetch: async () => new Response("{}"), minIntervalMs: 0 });
    expect(again.session?.token).toBe("tok");
  });

  it("re-logs in once on an expired token", async () => {
    let n = 0;
    const { client, calls } = fakeSpeediance({
      ...loginRoutes(),
      "GET /x": () => (n++ === 0 ? { code: 91, message: "expired" } : { code: 0, data: [1] }),
    });
    expect(await client.get("/x")).toEqual([1]);
    expect(calls.filter((c) => c.path.endsWith("byPass"))).toHaveLength(2);
  });

  it("surfaces API rejections and keeps huge ids exact", async () => {
    const { client } = fakeSpeediance({
      ...loginRoutes("tok", { unit: 0 }),
      "GET /bad": () => ({ code: 500, message: "nope" }),
      "GET /big": () => '{"code":0,"data":{"id":12345678901234567890}}',
    });
    await expect(client.get("/bad")).rejects.toBeInstanceOf(RejectedError);
    expect(await client.get("/big")).toEqual({ id: "12345678901234567890" });
    expect(client.unit).toBe("kg");
  });

  it("needs SPEEDIANCE_UNIT when the login doesn't report it", async () => {
    const { client } = fakeSpeediance({ ...loginRoutes("tok", {}), "GET /x": () => ({ code: 0, data: 1 }) });
    await expect(client.get("/x")).rejects.toThrow(/SPEEDIANCE_UNIT/);
    const withUnit = fakeSpeediance({ ...loginRoutes("tok", {}), "GET /x": () => ({ code: 0, data: 1 }) }, { SPEEDIANCE_UNIT: "kg" });
    expect(await withUnit.client.get("/x")).toBe(1);
    expect(withUnit.client.unit).toBe("kg");
  });

  it("reports a bad password as an AuthError", async () => {
    const { client } = fakeSpeediance({
      ...loginRoutes(),
      "POST /api/app/v2/login/byPass": () => ({ code: 1001, message: "Wrong password" }),
    });
    await expect(client.login()).rejects.toThrow(AuthError);
  });
});
