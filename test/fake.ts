import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeedianceClient } from "../src/client.js";
import { SessionStore, loadSettings } from "../src/config.js";

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: any;
}

type Handler = (call: Call) => unknown;

/** A minimal fake of the Speediance API: route "METHOD /path" -> handler returning the JSON body. */
export function fakeSpeediance(routes: Record<string, Handler>, env: Record<string, string> = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return new Response("not found", { status: 404 });
    const out = handler(call);
    return new Response(typeof out === "string" ? out : JSON.stringify(out), { status: 200 });
  }) as typeof globalThis.fetch;

  const home = mkdtempSync(join(tmpdir(), "eau-gm-"));
  const settings = loadSettings({ SPEEDIANCE_EMAIL: "me@example.com", SPEEDIANCE_PASSWORD: "pw", SPEEDIANCE_MCP_HOME: home, ...env });
  const store = new SessionStore(home);
  const client = new SpeedianceClient(settings, store, { fetch, minIntervalMs: 0 });
  return { client, calls, store, home, settings };
}

export const loginRoutes = (token = "tok", extra: Record<string, unknown> = { unit: 1 }): Record<string, Handler> => ({
  "POST /api/app/v2/login/verifyIdentity": () => ({ code: 0, data: { isExist: true, hasPwd: true } }),
  "POST /api/app/v2/login/byPass": () => ({ code: 0, data: { token, appUserId: 42, ...extra } }),
});
