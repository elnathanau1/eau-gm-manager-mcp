import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Region = "Global" | "EU";
export type Unit = "lb" | "kg";
export type ClientType = "phone" | "gym-monster" | "nano" | "bike";

export interface Settings {
  email?: string;
  password?: string;
  region: Region;
  /** Speediance device type: 1 = Gym Monster. */
  deviceType: number;
  /** Which session "slot" to sign in with. See README: a login signs out whatever else uses that slot. */
  clientType: ClientType;
  /** Account display unit override. Only needed when the login response doesn't report it. */
  unit?: Unit;
  /** Directory for the cached session token and the exercise-library cache. */
  homeDir: string;
}

/** What we persist after a successful login, so restarts don't need a fresh login. */
export interface Session {
  token: string;
  userId: string;
  unit: Unit;
  region: Region;
  email: string;
  clientType: ClientType;
}

const CLIENT_TYPES: ClientType[] = ["phone", "gym-monster", "nano", "bike"];

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const region = (env.SPEEDIANCE_REGION || "Global") as Region;
  if (region !== "Global" && region !== "EU") {
    throw new Error(`SPEEDIANCE_REGION must be "Global" or "EU", got "${region}".`);
  }
  const clientType = (env.SPEEDIANCE_CLIENT_TYPE || "bike") as ClientType;
  if (!CLIENT_TYPES.includes(clientType)) {
    throw new Error(`SPEEDIANCE_CLIENT_TYPE must be one of ${CLIENT_TYPES.join(", ")}.`);
  }
  const unit = env.SPEEDIANCE_UNIT?.toLowerCase();
  if (unit !== undefined && unit !== "" && unit !== "lb" && unit !== "kg") {
    throw new Error(`SPEEDIANCE_UNIT must be "lb" or "kg", got "${unit}".`);
  }
  const deviceType = Number(env.SPEEDIANCE_DEVICE_TYPE || "1");
  if (!Number.isInteger(deviceType) || deviceType < 1) {
    throw new Error("SPEEDIANCE_DEVICE_TYPE must be a positive whole number (1 = Gym Monster).");
  }
  return {
    email: env.SPEEDIANCE_EMAIL || undefined,
    password: env.SPEEDIANCE_PASSWORD || undefined,
    region,
    deviceType,
    clientType,
    unit: unit ? (unit as Unit) : undefined,
    homeDir: env.SPEEDIANCE_MCP_HOME || join(homedir(), ".eau-gm-manager-mcp"),
  };
}

export class SessionStore {
  readonly path: string;

  constructor(private readonly dir: string) {
    this.path = join(dir, "session.json");
  }

  load(): Session | undefined {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      if (data && typeof data.token === "string" && typeof data.userId === "string") return data as Session;
    } catch {
      // Missing or corrupt: treat as signed out.
    }
    return undefined;
  }

  save(session: Session): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(session, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
  }

  clear(): void {
    if (existsSync(this.path)) rmSync(this.path);
  }
}
