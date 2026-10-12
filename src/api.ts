/** Typed-ish wrappers over the Speediance endpoints this server uses. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { NotFoundError, RejectedError, type SpeedianceClient } from "./client.js";

const LIBRARY_TTL_MS = 24 * 3600 * 1000;
const LIBRARY_BATCH = 50;

type Row = Record<string, any>;

// History records and the detail routes number session types differently; this maps a
// history-feed `type` to where its per-set detail lives.
const DETAIL_ROUTES: Record<number, string> = {
  1: "freeTraining", // Free Lift
  6: "freeTraining",
  7: "freeTraining", // guided / quick cardio
  2: "courseTrainingInfoDetail", // Speediance courses / programs
  3: "cttTrainingInfoDetail", // custom templates
  5: "cttTrainingInfoDetail",
  4: "aiCourseTrainingInfoDetail", // AI / goal-focused
  9: "aiCourseTrainingInfoDetail",
};
const ALL_DETAIL_ROUTES = ["cttTrainingInfoDetail", "courseTrainingInfoDetail", "freeTraining", "aiCourseTrainingInfoDetail"];

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export class SpeedianceAPI {
  constructor(
    readonly client: SpeedianceClient,
    private readonly cacheDir: string,
  ) {}

  get unit() {
    return this.client.unit;
  }

  get deviceType() {
    return this.client.deviceType;
  }

  // --- account & history --------------------------------------------------
  profile(): Promise<Row> {
    return this.client.get<Row>("/api/app/userinfo/info").then((d) => d ?? {});
  }

  async history(start: string, end: string): Promise<Row[]> {
    const rows = await this.client.get<Row[]>("/api/mobile/v2/report/userTrainingDataRecord", {
      startDate: start,
      endDate: end,
    });
    return (rows ?? []).filter((r) => r && typeof r === "object");
  }

  stats(start: string, end: string): Promise<Row> {
    return this.client
      .get<Row>("/api/mobile/v2/report/userTrainingDataStat", { startDate: start, endDate: end })
      .then((d) => d ?? {});
  }

  calendar(month: string): Promise<Row[]> {
    return this.client
      .get<Row[]>("/api/app/v5/trainingCalendar/monthNew", { date: month, selectedDeviceType: this.deviceType })
      .then((d) => d ?? []);
  }

  /** Per-set detail for one session. Tries the route matching its type, then the rest. */
  async sessionDetail(trainingId: number | string, sessionType?: number): Promise<{ route: string; data: unknown }> {
    const preferred = sessionType !== undefined ? DETAIL_ROUTES[sessionType] : undefined;
    const routes = preferred ? [preferred, ...ALL_DETAIL_ROUTES.filter((r) => r !== preferred)] : ALL_DETAIL_ROUTES;
    for (const route of routes) {
      try {
        const data = await this.client.get(`/api/app/trainingInfo/${route}/${trainingId}`);
        if (data && !(Array.isArray(data) && data.length === 0)) return { route, data };
      } catch (err) {
        // "You do not have access" means the id lives in another namespace; keep looking.
        if (err instanceof NotFoundError || err instanceof RejectedError) continue;
        throw err;
      }
    }
    return { route: routes[0], data: null };
  }

  /** Weekly stat rows for one movement (each row is a week, keyed by its Monday). */
  async exerciseStats(groupId: number, maxWeeks = 52): Promise<Row[]> {
    const out: Row[] = [];
    for (let page = 1; out.length < maxWeeks; page++) {
      const rows =
        (await this.client.get<Row[]>("/api/app/actionLibraryGroup/userActionStatPage", {
          id: groupId,
          pageNo: page,
          pageSize: 50,
        })) ?? [];
      out.push(...rows);
      if (rows.length < 50) break;
    }
    return out.slice(0, maxWeeks);
  }

  // --- custom workout templates ------------------------------------------
  templates(): Promise<Row[]> {
    return this.client
      .get<Row[]>("/api/app/v4/customTrainingTemplate/appPage", {
        pageNo: 1,
        pageSize: -1,
        deviceTypes: this.deviceType,
      })
      .then((d) => d ?? []);
  }

  template(code: string): Promise<Row | null> {
    return this.client.get<Row | null>("/api/app/v3/customTrainingTemplate/detailByCode", { code });
  }

  saveTemplate(body: Row): Promise<unknown> {
    return this.client.post("/api/app/v2/customTrainingTemplate", body);
  }

  deleteTemplate(id: number): Promise<unknown> {
    return this.client.delete("/api/app/customTrainingTemplate", { ids: id });
  }

  /** status 1 schedules the template on that day; 0 removes it. */
  reserve(date: string, code: string, status: 0 | 1): Promise<unknown> {
    return this.client.post("/api/app/templateReservation", {
      status,
      deviceType: this.deviceType,
      thatDay: date,
      templateCode: code,
    });
  }

  // --- exercise library ---------------------------------------------------
  accessories(): Promise<Row[]> {
    return this.client.get<Row[]>("/api/app/accessories/list").then((d) => d ?? []);
  }

  exercise(groupId: number): Promise<Row> {
    return this.client.get<Row>(`/api/app/actionLibraryGroup/${groupId}`, { isDisplay: 1 }).then((d) => d ?? {});
  }

  private libraryPromise: Promise<Row[]> | undefined;

  /** The full exercise catalog (~1,000 movements), cached on disk for 24h. */
  library(force = false): Promise<Row[]> {
    const path = join(this.cacheDir, `library-${this.client.region}-${this.deviceType}.json`);
    if (!force) {
      try {
        const cached = JSON.parse(readFileSync(path, "utf8"));
        if (Date.now() - cached.fetchedAt < LIBRARY_TTL_MS && Array.isArray(cached.items)) {
          return Promise.resolve(cached.items);
        }
      } catch {
        // No usable cache.
      }
    }
    this.libraryPromise ??= this.fetchLibrary()
      .then((items) => {
        try {
          mkdirSync(this.cacheDir, { recursive: true });
          writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), items }));
        } catch {
          // Cache is best effort.
        }
        return items;
      })
      .finally(() => {
        this.libraryPromise = undefined;
      });
    return this.libraryPromise;
  }

  private async fetchLibrary(): Promise<Row[]> {
    const device = this.deviceType;
    const tabs = (await this.client.get<Row[]>("/api/app/actionLibraryTab/list", { deviceType: device })) ?? [];
    const order: number[] = [];
    const tabOf = new Map<number, string>();
    for (const tab of tabs) {
      const groups =
        (await this.client.get<Row[]>("/api/app/actionLibraryGroup/trainingPartGroup", {
          tabId: tab.id,
          deviceTypeList: device,
        })) ?? [];
      for (const group of groups) {
        for (const action of group.actionLibraryGroupList ?? []) {
          if (action?.id != null && !tabOf.has(action.id)) {
            tabOf.set(action.id, tab.name ?? "");
            order.push(action.id);
          }
        }
      }
    }
    const items: Row[] = [];
    for (let i = 0; i < order.length; i += LIBRARY_BATCH) {
      const rows =
        (await this.client.get<Row[]>("/api/app/actionLibraryGroup/list", { ids: order.slice(i, i + LIBRARY_BATCH) })) ??
        [];
      for (const raw of rows) {
        if (!raw || typeof raw !== "object") continue;
        raw.tabName ??= tabOf.get(raw.id) ?? "";
        items.push(raw);
      }
    }
    return items;
  }
}
