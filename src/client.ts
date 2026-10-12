/**
 * HTTP client for the private Speediance mobile-app API.
 *
 * Speediance publishes no official API. This speaks the same protocol as the
 * phone app (headers, login flow, response envelope), as documented by the
 * community projects credited in the README. It can break whenever Speediance
 * changes their backend; this file is the place to fix it when it does.
 */
import type { ClientType, Region, Session, SessionStore, Settings, Unit } from "./config.js";

export const HOSTS: Record<Region, string> = {
  Global: "https://api2.speediance.com",
  EU: "https://euapi.speediance.com",
};

// The server gates content on the declared app version. Don't bump this casually:
// implausible or rapidly changing values trip an anti-abuse "Invalid nonce string" throttle.
const VERSION_CODE = "41000";
const USER_AGENT = "Dart/3.9 (dart:io)";
const MOBILE_DEVICES =
  '{"brand":"google","device":"emulator64_x86_64_arm64","deviceType":"sdk_gphone64_x86_64",' +
  '"os":"","os_version":"31","manufacturer":"Google"}';

const CODE_TOKEN_EXPIRED = 91;
/** Another login with the same client type took over this session. */
const CODE_DISPLACED = 90;

// Speediance keeps one live session per client type (the App_type header). Logging in
// with a type signs out whatever else holds it. Only the login uses the chosen slot;
// every other request is sent as the phone app, which accepts a token from any slot.
const LOGIN_HEADERS: Record<ClientType, [appType: string, versionCode: string]> = {
  phone: ["SOFTWARE", VERSION_CODE],
  "gym-monster": ["HARDWARE", "1"],
  nano: ["NANO", "1"],
  bike: ["BIKE", "1"],
};
/** Slots it's safe to silently re-take; re-taking the phone's or machine's would sign that device out. */
const RELOGIN_ON_DISPLACED: ClientType[] = ["nano", "bike"];

export class SpeedianceError extends Error {}
export class AuthError extends SpeedianceError {}
export class NotFoundError extends SpeedianceError {}
export class RejectedError extends SpeedianceError {
  constructor(
    readonly code: unknown,
    readonly apiMessage: string,
  ) {
    super(`Speediance rejected the request (code ${String(code)}): ${apiMessage}`);
  }
}

type Fetch = typeof fetch;
type Query = Record<string, string | number | boolean | Array<string | number> | undefined>;

export interface ClientOptions {
  fetch?: Fetch;
  /** Minimum gap between requests, to stay well clear of rate limiting. */
  minIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function tzHeaders(): Record<string, string> {
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
  let name = Intl.DateTimeFormat().resolvedOptions().timeZone || "GMT";
  // Header values must be ASCII.
  if (!/^[\x20-\x7e]+$/.test(name)) name = "GMT";
  return { Timezone: name, Utc_offset: offset };
}

export class SpeedianceClient {
  session: Session | undefined;
  private readonly fetchImpl: Fetch;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private loginInFlight: Promise<Session> | undefined;

  constructor(
    private readonly settings: Settings,
    private readonly store: SessionStore,
    opts: ClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.minIntervalMs = opts.minIntervalMs ?? 1000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    const saved = store.load();
    // A cached session from another region or account isn't usable.
    if (saved && saved.region === settings.region && (!settings.email || saved.email === settings.email)) {
      this.session = saved;
    }
  }

  get unit(): Unit {
    return this.session?.unit ?? this.settings.unit ?? "lb";
  }

  get deviceType(): number {
    return this.settings.deviceType;
  }

  get region(): Region {
    return this.settings.region;
  }

  private headers(auth: boolean, loginAs?: ClientType): Record<string, string> {
    const [appType, versionCode] = loginAs ? LOGIN_HEADERS[loginAs] : ["SOFTWARE", VERSION_CODE];
    const h: Record<string, string> = {
      Timestamp: String(this.now()),
      Versioncode: versionCode,
      Mobiledevices: MOBILE_DEVICES,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      App_type: appType,
      "Accept-Language": "en",
      ...tzHeaders(),
    };
    if (auth && this.session) {
      h.App_user_id = this.session.userId;
      h.Token = this.session.token;
    }
    return h;
  }

  /** Serializes requests and spaces them out by minIntervalMs. */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (this.lastRequestAt && wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(
    method: string,
    path: string,
    { query, body, auth, loginAs }: { query?: Query; body?: unknown; auth: boolean; loginAs?: ClientType },
  ): Promise<{ status: number; code: unknown; message: string; data: unknown }> {
    const url = new URL(path, HOSTS[this.settings.region]);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((v) => url.searchParams.append(key, String(v)));
      else url.searchParams.set(key, String(value));
    }
    return this.throttled(async () => {
      let resp: Response;
      try {
        resp = await this.fetchImpl(url, {
          method,
          headers: this.headers(auth, loginAs),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        throw new SpeedianceError(`Could not reach Speediance: ${(err as Error).message}`);
      }
      if (resp.status === 404) throw new NotFoundError(`Speediance has no route ${method} ${url.pathname}`);
      if (resp.status >= 500) throw new SpeedianceError(`Speediance server error (HTTP ${resp.status})`);
      let json: unknown;
      try {
        // Ids can exceed 2^53; keep very long integers as strings so they survive JSON.parse.
        json = JSON.parse((await resp.text()).replace(/(:\s*)(-?\d{16,})(?=\s*[,}\]])/g, '$1"$2"'));
      } catch {
        throw new SpeedianceError(`Unexpected non-JSON response from Speediance (HTTP ${resp.status})`);
      }
      const env = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
      return {
        status: resp.status,
        code: env.code,
        message: String(env.message ?? env.msg ?? ""),
        data: "data" in env ? env.data : json,
      };
    });
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
    retried = false,
  ): Promise<T> {
    if (!this.session) await this.login();
    const sentToken = this.session?.token;
    const res = await this.send(method, path, { ...opts, auth: true });

    const expired = res.status === 401 || res.code === CODE_TOKEN_EXPIRED;
    const displaced = res.code === CODE_DISPLACED;
    if (expired || displaced) {
      const mayRelogin = expired || RELOGIN_ON_DISPLACED.includes(this.settings.clientType);
      if (!retried && mayRelogin && this.canLogin()) {
        // Another concurrent call may already have refreshed the token.
        if (this.session?.token === sentToken) await this.login();
        return this.request<T>(method, path, opts, true);
      }
      throw new AuthError(
        displaced
          ? `Speediance was signed in elsewhere with the same client type (${this.settings.clientType}), ending this session. Run the login command again.`
          : res.message || "Speediance login expired. Run the login command again.",
      );
    }
    if (res.code !== undefined && res.code !== null && res.code !== 0) {
      throw new RejectedError(res.code, res.message);
    }
    return res.data as T;
  }

  get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T = unknown>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  delete<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { query });
  }

  canLogin(): boolean {
    return Boolean(this.settings.email && this.settings.password);
  }

  /** Two-step email/password login. Concurrent callers share one attempt. */
  login(email = this.settings.email, password = this.settings.password): Promise<Session> {
    if (!email || !password) {
      return Promise.reject(
        new AuthError(
          "Not signed in to Speediance. Set SPEEDIANCE_EMAIL and SPEEDIANCE_PASSWORD, or run `eau-gm-manager-mcp login`.",
        ),
      );
    }
    this.loginInFlight ??= this.doLogin(email, password).finally(() => {
      this.loginInFlight = undefined;
    });
    return this.loginInFlight;
  }

  private async doLogin(email: string, password: string): Promise<Session> {
    const loginAs = this.settings.clientType;
    const verify = await this.send("POST", "/api/app/v2/login/verifyIdentity", {
      body: { type: 2, userIdentity: email },
      auth: false,
      loginAs,
    });
    if (verify.code !== 0) throw new AuthError(`Login failed: ${verify.message || `code ${String(verify.code)}`}`);
    const v = (verify.data ?? {}) as { isExist?: boolean; hasPwd?: boolean };
    if (v.isExist === false) throw new AuthError("No Speediance account uses that email.");
    if (v.hasPwd === false) {
      throw new AuthError(
        "That Speediance account has no password (e.g. it signs in with Google/Apple). Set a password in the Speediance app first.",
      );
    }

    const res = await this.send("POST", "/api/app/v2/login/byPass", {
      body: { userIdentity: email, password, type: 2 },
      auth: false,
      loginAs,
    });
    if (res.code !== 0) throw new AuthError(`Login failed: ${res.message || `code ${String(res.code)}`}`);
    const data = (res.data ?? {}) as { token?: string; appUserId?: string | number; unit?: number };
    if (!data.token || data.appUserId === undefined) throw new AuthError("Speediance's login response had no token.");

    // Only the phone-slot login reports the display unit (unit: 1 = lb).
    let unit: Unit | undefined = data.unit === undefined || data.unit === null ? undefined : data.unit === 1 ? "lb" : "kg";
    unit ??= this.settings.unit ?? (this.session?.email === email ? this.session.unit : undefined);
    if (!unit) {
      throw new AuthError(
        "Speediance didn't say whether this account uses lb or kg. Set SPEEDIANCE_UNIT to lb or kg (whatever the Speediance app shows) and try again.",
      );
    }

    this.session = {
      token: data.token,
      userId: String(data.appUserId),
      unit,
      region: this.settings.region,
      email,
      clientType: loginAs,
    };
    this.store.save(this.session);
    return this.session;
  }
}
