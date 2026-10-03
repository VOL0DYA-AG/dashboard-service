import Keycloak from "keycloak-js";
import {
  REALM,
  applyAttribute,
  applyWrite,
  datapointQuery,
  demoPlant,
  historySeries,
  parseDatapoints,
  parsePlant,
  simulateHistory,
  unwrapAssets,
  stepSimulation,
  type AttributeWrite,
  type ChartPoint,
  type Plant,
} from "@contract";

export interface CabinetApi {
  username: string;
  mock: boolean;
  load(): Promise<Plant>;
  write(write: AttributeWrite): Promise<void>;
  history(plant: Plant, from: number, to: number): Promise<Record<string, ChartPoint[]>>;
  subscribe(listener: (plant: Plant) => void): () => void;
}

export interface CabinetConfig {
  managerUrl: string;
  realm: string;
}

/** Адрес живого Manager. Пустая строка означает тот же хост, с которого открыт кабинет. */
export async function loadConfig(): Promise<CabinetConfig> {
  const fallback: CabinetConfig = {
    managerUrl: (import.meta.env.VITE_MANAGER_URL || "").replace(/\/$/, ""),
    realm: import.meta.env.VITE_REALM || REALM,
  };
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: "no-store" });
    if (!response.ok) return fallback;
    const json = (await response.json()) as { managerUrl?: string; realm?: string };
    return {
      managerUrl: String(json.managerUrl ?? fallback.managerUrl).replace(/\/$/, ""),
      realm: json.realm || fallback.realm,
    };
  } catch {
    return fallback;
  }
}

export async function createApi(): Promise<CabinetApi> {
  if (import.meta.env.VITE_MOCK === "true") return new MockApi();
  return RealApi.connect(await loadConfig());
}

class MockApi implements CabinetApi {
  username = "operator";
  mock = true;
  private plant: Plant;
  private frames: Array<{ t: number; plant: Plant }>;
  private listeners = new Set<(plant: Plant) => void>();
  constructor() {
    const now = Date.now();
    const origin = demoPlant(now - 6 * 3_600_000);
    const played = simulateHistory(origin, 6, 5, now);
    this.frames = played.map((plant, index) => ({
      t: now - (played.length - index) * 5 * 60_000,
      plant,
    }));
    this.plant = played.at(-1) ?? origin;
    window.setInterval(() => {
      this.plant = stepSimulation(this.plant, 0.5);
      this.frames.push({ t: Date.now(), plant: this.plant });
      if (this.frames.length > 2000) this.frames.splice(0, this.frames.length - 2000);
      this.emit();
    }, 2000);
  }

  async load(): Promise<Plant> {
    return this.plant;
  }

  async write(write: AttributeWrite): Promise<void> {
    this.plant = applyWrite(this.plant, write);
    this.plant = stepSimulation(this.plant, 0.2);
    this.emit();
  }

  async history(plant: Plant, from: number, to: number): Promise<Record<string, ChartPoint[]>> {
    const result: Record<string, ChartPoint[]> = {};
    for (const series of historySeries(plant)) {
      result[series.id] = this.frames
        .filter((frame) => frame.t >= from && frame.t <= to)
        .map((frame) => ({ t: frame.t, v: readSeries(frame.plant, series.assetId, series.attribute) }))
        .filter((point) => Number.isFinite(point.v));
    }
    return result;
  }

  subscribe(listener: (plant: Plant) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.plant);
  }
}

class RealApi implements CabinetApi {
  username: string;
  mock = false;
  private listeners = new Set<(plant: Plant) => void>();
  private socket: WebSocket | null = null;
  private plant: Plant | null = null;
  private stopped = false;

  private constructor(
    private readonly keycloak: Keycloak,
    private readonly config: CabinetConfig,
  ) {
    this.username = keycloak.tokenParsed?.preferred_username || "operator";
  }

  static async connect(config: CabinetConfig): Promise<RealApi> {
    const origin = config.managerUrl || window.location.origin;
    const keycloak = new Keycloak({
      url: `${origin}/auth`,
      realm: config.realm,
      clientId: "openremote",
    });
    let ok = false;
    try {
      ok = await keycloak.init({
        onLoad: "login-required",
        // На http://адрес:порт браузер не даёт crypto.subtle, а он нужен только для PKCE.
        // Клиент openremote принимает вход и без него. По https PKCE включается сам.
        pkceMethod: window.isSecureContext ? "S256" : undefined,
        checkLoginIframe: false,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Не открылась страница входа ${origin}. Сначала откройте ${origin} в этом же браузере и подтвердите предупреждение о сертификате, затем обновите кабинет. Подробность: ${detail}`,
      );
    }
    if (!ok) throw new Error("Вход в OpenRemote не выполнен");
    const api = new RealApi(keycloak, config);
    api.openSocket();
    return api;
  }

  async load(): Promise<Plant> {
    let body: unknown;
    try {
      body = await this.json<unknown>("POST", `/api/${this.realm()}/asset/query`, {});
    } catch (error) {
      if (error instanceof TypeError) {
        const where = this.config.managerUrl || "OpenRemote";
        throw new Error(
          `Браузер не смог спросить данные у ${where}. Откройте ${where} и подтвердите предупреждение о сертификате. Если сертификат уже принят, на сервере OpenRemote ещё не разрешён адрес этого кабинета.`,
        );
      }
      throw error;
    }
    const assets = unwrapAssets(body);
    const plant = parsePlant(assets);
    if (!plant) {
      throw new Error("В realm нет котельной. Нужен актив с атрибутом cabinetKind = plant и дочерний котёл.");
    }
    this.plant = plant;
    return plant;
  }

  async write(write: AttributeWrite): Promise<void> {
    if (this.plant) this.plant = applyWrite(this.plant, write);
    const response = await this.fetch("PUT", `/api/${this.realm()}/asset/${write.id}/attribute/${write.name}`, write.value);
    if (!response.ok) {
      throw new Error(await response.text());
    }
  }

  async history(plant: Plant, from: number, to: number): Promise<Record<string, ChartPoint[]>> {
    const entries = await Promise.all(
      historySeries(plant).map(async (series) => {
        const response = await this.fetch(
          "POST",
          `/api/${this.realm()}/asset/datapoint/${series.assetId}/attribute/${series.attribute}`,
          datapointQuery(from, to),
        );
        if (!response.ok) return [series.id, []] as const;
        return [series.id, parseDatapoints(await response.json())] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  subscribe(listener: (plant: Plant) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private realm(): string {
    return this.config.realm;
  }

  private url(path: string): string {
    return `${this.config.managerUrl}${path}`;
  }

  private async token(): Promise<string> {
    await this.keycloak.updateToken(30);
    if (!this.keycloak.token) throw new Error("Сессия истекла, войдите снова");
    return this.keycloak.token;
  }

  private async fetch(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.token();
    return fetch(this.url(path), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetch(method, path, body);
    if (response.status === 401 || response.status === 403) {
      throw new Error("Вход есть, но OpenRemote не показал карточки котельной. На сервере кабинета ещё раз запустите шаг настройки.");
    }
    if (!response.ok) throw new Error(`${method} ${path} → HTTP ${response.status}`);
    return response.json() as Promise<T>;
  }

  private openSocket(): void {
    if (this.stopped || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    void this.token().then((token) => {
      const origin = this.config.managerUrl || window.location.origin;
      const url = `${origin.replace(/^http/, "ws")}/websocket/events?Realm=${encodeURIComponent(this.realm())}`;
      const socket = new WebSocket(url, ["Bearer", token]);
      this.socket = socket;
      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ eventType: "attribute", subscriptionId: "cabinet" }));
      });
      socket.addEventListener("message", (event) => {
        this.onMessage(String(event.data));
      });
      socket.addEventListener("close", () => {
        if (!this.stopped) window.setTimeout(() => this.openSocket(), 3000);
      });
    }).catch(() => {
      window.setTimeout(() => this.openSocket(), 5000);
    });
  }

  private onMessage(raw: string): void {
    if (!this.plant) return;
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const events = Array.isArray(payload) ? payload : [payload];
    let next = this.plant;
    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      const row = event as { eventType?: string; ref?: { id?: string; name?: string }; id?: string; name?: string; value?: unknown };
      if (row.eventType && row.eventType !== "attribute") continue;
      const id = row.ref?.id || row.id;
      const name = row.ref?.name || row.name;
      if (!id || !name || !("value" in row)) continue;
      next = applyAttribute(next, id, name, unwrap(row.value));
    }
    this.plant = next;
    for (const listener of this.listeners) listener(next);
  }
}

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    return (value as { value: unknown }).value;
  }
  return value;
}

function readSeries(plant: Plant, assetId: string, attribute: string): number {
  if (plant.id === assetId && attribute === "outdoorTemperature") return plant.outdoorTemperature;
  if (plant.boiler.id === assetId && attribute === "supplyTemperature") return plant.boiler.supplyTemperature;
  if (plant.boiler.id === assetId && attribute === "returnTemperature") return plant.boiler.returnTemperature;
  const circuit = plant.circuits.find((item) => item.id === assetId);
  if (circuit && attribute === "roomTemperature") return circuit.roomTemperature;
  if (plant.dhw && plant.dhw.id === assetId && attribute === "temperature") return plant.dhw.temperature;
  return NaN;
}
