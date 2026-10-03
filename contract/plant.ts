/**
 * Контракт личного кабинета и OpenRemote.
 *
 * Кабинет не заводит свои типы активов. Любой ThingAsset подходит, если у него
 * есть атрибут cabinetKind и согласованные имена атрибутов ниже.
 * Симулятор и интерфейс импортируют этот файл, чтобы не разъехаться.
 */

export const REALM = "boiler";
export const PLANT_NAME = "Котельная, дом 12";

export const ATTR = {
  kind: "cabinetKind",
  outdoor: "outdoorTemperature",
  online: "online",
  alarmActive: "alarmActive",
  alarmText: "alarmText",
  journal: "journal",
  status: "status",
  supply: "supplyTemperature",
  returnTemp: "returnTemperature",
  flame: "flame",
  enabled: "enabled",
  maxSupply: "maxSupplySetpoint",
  room: "roomTemperature",
  flow: "flowTemperature",
  setpoint: "setpoint",
  mode: "mode",
  pump: "pumpOn",
  temperature: "temperature",
} as const;

export const MODES = ["comfort", "eco", "antifreeze", "off"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABEL: Record<Mode, string> = {
  comfort: "Комфорт",
  eco: "Эконом",
  antifreeze: "Антизамерзание",
  off: "Выключено",
};

export const STATUS_LABEL: Record<BoilerStatus, string> = {
  heating: "Работает",
  standby: "Ожидание",
  off: "Выключен",
  fault: "Авария",
};

export type BoilerStatus = "heating" | "standby" | "off" | "fault";

export const LIMITS = {
  circuit: { min: 10, max: 30, step: 0.5 },
  dhw: { min: 30, max: 70, step: 1 },
  maxSupply: { min: 40, max: 85, step: 1 },
} as const;

export interface JournalEntry {
  t: number;
  level: "info" | "alarm" | "ok";
  text: string;
}

export interface Boiler {
  id: string;
  name: string;
  status: BoilerStatus;
  supplyTemperature: number;
  returnTemperature: number;
  flame: boolean;
  enabled: boolean;
  maxSupplySetpoint: number;
}

export interface Circuit {
  id: string;
  name: string;
  roomTemperature: number;
  flowTemperature: number;
  setpoint: number;
  mode: Mode;
  pumpOn: boolean;
}

export interface Dhw {
  id: string;
  name: string;
  temperature: number;
  setpoint: number;
  mode: Mode;
  pumpOn: boolean;
}

export interface Plant {
  id: string;
  name: string;
  online: boolean;
  outdoorTemperature: number;
  alarmActive: boolean;
  alarmText: string;
  journal: JournalEntry[];
  boiler: Boiler;
  circuits: Circuit[];
  dhw: Dhw | null;
}

export interface RawAttribute {
  type?: string;
  value?: unknown;
  timestamp?: number;
}

export interface RawAsset {
  id: string;
  name?: string;
  type?: string;
  parentId?: string | null;
  attributes?: Record<string, RawAttribute | unknown>;
}

export interface AttributeWrite {
  id: string;
  name: string;
  value: unknown;
}

export interface ChartPoint {
  t: number;
  v: number;
}

const ANTIFREEZE_ROOM = 8;
const ANTIFREEZE_DHW = 15;
const ECO_ROOM_DROP = 3;
const ECO_DHW_DROP = 8;

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export function isStatus(value: unknown): value is BoilerStatus {
  return value === "heating" || value === "standby" || value === "off" || value === "fault";
}

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function clampSetpoint(kind: "circuit" | "dhw" | "maxSupply", value: number): number {
  const limit = LIMITS[kind];
  const stepped = Math.round(value / limit.step) * limit.step;
  const clamped = Math.min(limit.max, Math.max(limit.min, stepped));
  return Number(clamped.toFixed(1));
}

/** Целевая температура с учётом режима. null — контур выключен и тепло не запрашивает. */
export function targetTemperature(mode: Mode, setpoint: number, kind: "circuit" | "dhw"): number | null {
  if (mode === "off") return null;
  if (mode === "antifreeze") return kind === "circuit" ? ANTIFREEZE_ROOM : ANTIFREEZE_DHW;
  if (mode === "eco") return setpoint - (kind === "circuit" ? ECO_ROOM_DROP : ECO_DHW_DROP);
  return setpoint;
}

export function attrValue(asset: RawAsset, name: string): unknown {
  const bag = asset.attributes?.[name];
  if (bag && typeof bag === "object" && "value" in (bag as RawAttribute)) {
    return (bag as RawAttribute).value;
  }
  return undefined;
}

function kindOf(asset: RawAsset): string {
  return String(attrValue(asset, ATTR.kind) ?? "");
}

function parseJournal(value: unknown): JournalEntry[] {
  const text = typeof value === "string" ? value : "";
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is JournalEntry => {
        if (!item || typeof item !== "object") return false;
        const row = item as JournalEntry;
        return typeof row.t === "number" && typeof row.text === "string";
      })
      .slice(0, 40);
  } catch {
    return [];
  }
}

export function unwrapAssets(body: unknown): RawAsset[] {
  if (Array.isArray(body)) return body as RawAsset[];
  if (body && typeof body === "object" && Array.isArray((body as { assets?: unknown }).assets)) {
    return (body as { assets: RawAsset[] }).assets;
  }
  return [];
}

export function parsePlant(assets: RawAsset[]): Plant | null {
  const usable = assets.filter((asset) => asset && asset.id && kindOf(asset));
  const plantAsset = usable.find((asset) => kindOf(asset) === "plant");
  if (!plantAsset) return null;

  const linked = usable.filter((asset) => asset.parentId === plantAsset.id);
  const children = linked.length > 0 ? linked : usable.filter((asset) => asset.id !== plantAsset.id && !asset.parentId);
  const boilerAsset = children.find((asset) => kindOf(asset) === "boiler");
  const circuitAssets = children.filter((asset) => kindOf(asset) === "circuit");
  const dhwAsset = children.find((asset) => kindOf(asset) === "dhw");
  if (!boilerAsset) return null;

  const boiler: Boiler = {
    id: boilerAsset.id,
    name: boilerAsset.name || "Котёл",
    status: isStatus(attrValue(boilerAsset, ATTR.status)) ? (attrValue(boilerAsset, ATTR.status) as BoilerStatus) : "standby",
    supplyTemperature: num(attrValue(boilerAsset, ATTR.supply), 40),
    returnTemperature: num(attrValue(boilerAsset, ATTR.returnTemp), 30),
    flame: bool(attrValue(boilerAsset, ATTR.flame)),
    enabled: bool(attrValue(boilerAsset, ATTR.enabled), true),
    maxSupplySetpoint: num(attrValue(boilerAsset, ATTR.maxSupply), 70),
  };

  const circuits: Circuit[] = circuitAssets.map((asset) => ({
    id: asset.id,
    name: asset.name || "Контур",
    roomTemperature: num(attrValue(asset, ATTR.room), 20),
    flowTemperature: num(attrValue(asset, ATTR.flow), 35),
    setpoint: num(attrValue(asset, ATTR.setpoint), 21),
    mode: isMode(attrValue(asset, ATTR.mode)) ? (attrValue(asset, ATTR.mode) as Mode) : "comfort",
    pumpOn: bool(attrValue(asset, ATTR.pump)),
  }));

  const dhw: Dhw | null = dhwAsset
    ? {
        id: dhwAsset.id,
        name: dhwAsset.name || "ГВС",
        temperature: num(attrValue(dhwAsset, ATTR.temperature), 45),
        setpoint: num(attrValue(dhwAsset, ATTR.setpoint), 55),
        mode: isMode(attrValue(dhwAsset, ATTR.mode)) ? (attrValue(dhwAsset, ATTR.mode) as Mode) : "comfort",
        pumpOn: bool(attrValue(dhwAsset, ATTR.pump)),
      }
    : null;

  return {
    id: plantAsset.id,
    name: plantAsset.name || "Котельная",
    online: bool(attrValue(plantAsset, ATTR.online), true),
    outdoorTemperature: num(attrValue(plantAsset, ATTR.outdoor), 0),
    alarmActive: bool(attrValue(plantAsset, ATTR.alarmActive)),
    alarmText: String(attrValue(plantAsset, ATTR.alarmText) ?? ""),
    journal: parseJournal(attrValue(plantAsset, ATTR.journal)),
    boiler,
    circuits,
    dhw,
  };
}

function approach(current: number, goal: number, maxStep: number): number {
  const delta = goal - current;
  if (Math.abs(delta) <= maxStep) return goal;
  return current + Math.sign(delta) * maxStep;
}

function needsHeat(current: number, target: number | null): boolean {
  return target !== null && current < target - 0.4;
}

/**
 * Один шаг модели котельной.
 * Уставки не меняет: их пишет человек. Меняются измеренные температуры, насосы,
 * горелка, статус котла и текст аварии — то, что в бою пишет контроллер.
 */
export function stepSimulation(plant: Plant, minutes: number, now = Date.now()): Plant {
  const span = Math.max(0, minutes);
  const outdoor = approach(plant.outdoorTemperature, seasonalOutdoor(now), 0.05 * span);
  const next: Plant = {
    ...plant,
    outdoorTemperature: round1(outdoor),
    online: true,
    boiler: { ...plant.boiler },
    circuits: plant.circuits.map((circuit) => ({ ...circuit })),
    dhw: plant.dhw ? { ...plant.dhw } : null,
    journal: plant.journal.slice(0, 40),
  };

  let heatRequest = false;
  for (const circuit of next.circuits) {
    const target = targetTemperature(circuit.mode, circuit.setpoint, "circuit");
    const asking = next.boiler.enabled && needsHeat(circuit.roomTemperature, target);
    if (asking) heatRequest = true;
    const goal = target ?? outdoor;
    const rate = asking ? 0.35 : circuit.mode === "off" ? 0.08 : 0.05;
    circuit.roomTemperature = round1(approach(circuit.roomTemperature, goal, rate * span));
    circuit.pumpOn = circuit.mode !== "off" && next.boiler.enabled && (asking || circuit.roomTemperature < (target ?? 0) + 0.8);
    const flowGoal = circuit.pumpOn ? Math.min(next.boiler.maxSupplySetpoint, (target ?? circuit.setpoint) + 15) : outdoor;
    circuit.flowTemperature = round1(approach(circuit.flowTemperature, flowGoal, 1.2 * span));
  }

  if (next.dhw) {
    const target = targetTemperature(next.dhw.mode, next.dhw.setpoint, "dhw");
    const asking = next.boiler.enabled && needsHeat(next.dhw.temperature, target);
    if (asking) heatRequest = true;
    const goal = target ?? Math.max(outdoor, 10);
    next.dhw.temperature = round1(approach(next.dhw.temperature, goal, (asking ? 0.5 : 0.08) * span));
    next.dhw.pumpOn = next.dhw.mode !== "off" && next.boiler.enabled && asking;
  }

  if (!next.boiler.enabled) {
    next.boiler.status = "off";
    next.boiler.flame = false;
  } else if (heatRequest) {
    next.boiler.status = "heating";
    next.boiler.flame = true;
  } else {
    next.boiler.status = "standby";
    next.boiler.flame = false;
  }

  const supplyGoal = next.boiler.flame
    ? Math.min(next.boiler.maxSupplySetpoint, 62)
    : Math.max(outdoor, next.boiler.returnTemperature);
  next.boiler.supplyTemperature = round1(approach(next.boiler.supplyTemperature, supplyGoal, 1.5 * span));
  const returnGoal = next.circuits.reduce((sum, circuit) => sum + circuit.flowTemperature, next.boiler.supplyTemperature) /
    (next.circuits.length + 1);
  next.boiler.returnTemperature = round1(approach(next.boiler.returnTemperature, returnGoal - 8, 0.8 * span));

  const alarms: string[] = [];
  if (!next.boiler.enabled && outdoor < 1 && next.circuits.some((circuit) => circuit.mode !== "off")) {
    alarms.push("Котёл выключен, а на улице холодно");
  }
  if (next.boiler.supplyTemperature > next.boiler.maxSupplySetpoint + 3) {
    alarms.push("Подача выше предельной уставки");
  }
  const alarmText = alarms.join(". ");
  const wasAlarm = plant.alarmActive;
  next.alarmActive = alarms.length > 0;
  next.alarmText = alarmText;
  if (next.alarmActive && alarmText !== plant.alarmText) {
    const entry: JournalEntry = { t: now, level: "alarm", text: alarmText };
    next.journal = [entry, ...next.journal].slice(0, 40);
  } else if (wasAlarm && !next.alarmActive) {
    const entry: JournalEntry = { t: now, level: "ok", text: "Авария снята" };
    next.journal = [entry, ...next.journal].slice(0, 40);
  }
  return next;
}

/** Уставки берём с сервера, измеренные величины оставляем локальными. */
export function applyControls(local: Plant, remote: Plant): { plant: Plant; notes: JournalEntry[] } {
  const notes: JournalEntry[] = [];
  const now = Date.now();
  const plant: Plant = {
    ...local,
    name: remote.name,
    boiler: {
      ...local.boiler,
      id: remote.boiler.id,
      name: remote.boiler.name,
      enabled: remote.boiler.enabled,
      maxSupplySetpoint: remote.boiler.maxSupplySetpoint,
    },
    circuits: remote.circuits.map((remoteCircuit) => {
      const previous = local.circuits.find((item) => item.id === remoteCircuit.id);
      if (previous && previous.setpoint !== remoteCircuit.setpoint) {
        notes.push({ t: now, level: "info", text: `${remoteCircuit.name}: уставка ${formatTemp(remoteCircuit.setpoint)}` });
      }
      if (previous && previous.mode !== remoteCircuit.mode) {
        notes.push({ t: now, level: "info", text: `${remoteCircuit.name}: режим «${MODE_LABEL[remoteCircuit.mode]}»` });
      }
      return {
        ...(previous ?? remoteCircuit),
        id: remoteCircuit.id,
        name: remoteCircuit.name,
        setpoint: remoteCircuit.setpoint,
        mode: remoteCircuit.mode,
      };
    }),
    dhw: remote.dhw
      ? {
          ...(local.dhw && local.dhw.id === remote.dhw.id ? local.dhw : remote.dhw),
          id: remote.dhw.id,
          name: remote.dhw.name,
          setpoint: remote.dhw.setpoint,
          mode: remote.dhw.mode,
        }
      : null,
  };
  if (local.boiler.enabled !== remote.boiler.enabled) {
    notes.push({ t: now, level: "info", text: remote.boiler.enabled ? "Котёл включён" : "Котёл выключен" });
  }
  if (local.boiler.maxSupplySetpoint !== remote.boiler.maxSupplySetpoint) {
    notes.push({ t: now, level: "info", text: `Предел подачи ${formatTemp(remote.boiler.maxSupplySetpoint)}` });
  }
  return { plant, notes };
}

export function measurementWrites(plant: Plant): AttributeWrite[] {
  const writes: AttributeWrite[] = [
    { id: plant.id, name: ATTR.outdoor, value: plant.outdoorTemperature },
    { id: plant.id, name: ATTR.online, value: plant.online },
    { id: plant.id, name: ATTR.alarmActive, value: plant.alarmActive },
    { id: plant.id, name: ATTR.alarmText, value: plant.alarmText },
    { id: plant.id, name: ATTR.journal, value: JSON.stringify(plant.journal.slice(0, 40)) },
    { id: plant.boiler.id, name: ATTR.status, value: plant.boiler.status },
    { id: plant.boiler.id, name: ATTR.supply, value: plant.boiler.supplyTemperature },
    { id: plant.boiler.id, name: ATTR.returnTemp, value: plant.boiler.returnTemperature },
    { id: plant.boiler.id, name: ATTR.flame, value: plant.boiler.flame },
  ];
  for (const circuit of plant.circuits) {
    writes.push(
      { id: circuit.id, name: ATTR.room, value: circuit.roomTemperature },
      { id: circuit.id, name: ATTR.flow, value: circuit.flowTemperature },
      { id: circuit.id, name: ATTR.pump, value: circuit.pumpOn },
    );
  }
  if (plant.dhw) {
    writes.push(
      { id: plant.dhw.id, name: ATTR.temperature, value: plant.dhw.temperature },
      { id: plant.dhw.id, name: ATTR.pump, value: plant.dhw.pumpOn },
    );
  }
  return writes;
}

/** Подмешивает одно значение атрибута, в том числе пришедшее по WebSocket. */
export function applyAttribute(plant: Plant, id: string, name: string, value: unknown): Plant {
  const next: Plant = {
    ...plant,
    boiler: { ...plant.boiler },
    circuits: plant.circuits.map((circuit) => ({ ...circuit })),
    dhw: plant.dhw ? { ...plant.dhw } : null,
    journal: plant.journal.slice(),
  };
  if (id === next.id) {
    if (name === ATTR.outdoor) next.outdoorTemperature = num(value, next.outdoorTemperature);
    if (name === ATTR.online) next.online = bool(value, next.online);
    if (name === ATTR.alarmActive) next.alarmActive = bool(value, next.alarmActive);
    if (name === ATTR.alarmText) next.alarmText = String(value ?? "");
    if (name === ATTR.journal) next.journal = parseJournal(value);
    return next;
  }
  if (id === next.boiler.id) {
    if (name === ATTR.status && isStatus(value)) next.boiler.status = value;
    if (name === ATTR.supply) next.boiler.supplyTemperature = num(value, next.boiler.supplyTemperature);
    if (name === ATTR.returnTemp) next.boiler.returnTemperature = num(value, next.boiler.returnTemperature);
    if (name === ATTR.flame) next.boiler.flame = bool(value, next.boiler.flame);
    if (name === ATTR.enabled) next.boiler.enabled = bool(value, next.boiler.enabled);
    if (name === ATTR.maxSupply) next.boiler.maxSupplySetpoint = num(value, next.boiler.maxSupplySetpoint);
    return next;
  }
  next.circuits = next.circuits.map((circuit) => {
    if (circuit.id !== id) return circuit;
    if (name === ATTR.room) return { ...circuit, roomTemperature: num(value, circuit.roomTemperature) };
    if (name === ATTR.flow) return { ...circuit, flowTemperature: num(value, circuit.flowTemperature) };
    if (name === ATTR.setpoint) return { ...circuit, setpoint: num(value, circuit.setpoint) };
    if (name === ATTR.mode && isMode(value)) return { ...circuit, mode: value };
    if (name === ATTR.pump) return { ...circuit, pumpOn: bool(value, circuit.pumpOn) };
    return circuit;
  });
  if (next.dhw && next.dhw.id === id) {
    if (name === ATTR.temperature) next.dhw = { ...next.dhw, temperature: num(value, next.dhw.temperature) };
    if (name === ATTR.setpoint) next.dhw = { ...next.dhw, setpoint: num(value, next.dhw.setpoint) };
    if (name === ATTR.mode && isMode(value)) next.dhw = { ...next.dhw, mode: value };
    if (name === ATTR.pump) next.dhw = { ...next.dhw, pumpOn: bool(value, next.dhw.pumpOn) };
  }
  return next;
}

/** Локально отражает запись уставки, пока сервер не прислал событие. */
export function applyWrite(plant: Plant, write: AttributeWrite): Plant {
  const value =
    write.name === ATTR.setpoint || write.name === ATTR.maxSupply
      ? clampSetpoint(write.id === plant.dhw?.id ? "dhw" : write.name === ATTR.maxSupply ? "maxSupply" : "circuit", num(write.value))
      : write.value;
  return applyAttribute(plant, write.id, write.name, value);
}

export function controlWrites(plant: Plant): AttributeWrite[] {
  const writes: AttributeWrite[] = [
    { id: plant.boiler.id, name: ATTR.enabled, value: plant.boiler.enabled },
    { id: plant.boiler.id, name: ATTR.maxSupply, value: plant.boiler.maxSupplySetpoint },
  ];
  for (const circuit of plant.circuits) {
    writes.push(
      { id: circuit.id, name: ATTR.setpoint, value: circuit.setpoint },
      { id: circuit.id, name: ATTR.mode, value: circuit.mode },
    );
  }
  if (plant.dhw) {
    writes.push(
      { id: plant.dhw.id, name: ATTR.setpoint, value: plant.dhw.setpoint },
      { id: plant.dhw.id, name: ATTR.mode, value: plant.dhw.mode },
    );
  }
  return writes;
}

export function sameWrite(left: AttributeWrite, right: AttributeWrite): boolean {
  return left.id === right.id && left.name === right.name && Object.is(left.value, right.value);
}

export function historySeries(plant: Plant): Array<{ id: string; assetId: string; attribute: string; label: string; color: string }> {
  const series: Array<{ id: string; assetId: string; attribute: string; label: string; color: string }> = [
    { id: "outdoor", assetId: plant.id, attribute: ATTR.outdoor, label: "Улица", color: "#3b82f6" },
    { id: "supply", assetId: plant.boiler.id, attribute: ATTR.supply, label: "Подача", color: "#e15a1a" },
    { id: "return", assetId: plant.boiler.id, attribute: ATTR.returnTemp, label: "Обратка", color: "#b45309" },
  ];
  plant.circuits.forEach((circuit, index) => {
    series.push({
      id: `room-${circuit.id}`,
      assetId: circuit.id,
      attribute: ATTR.room,
      label: circuit.name,
      color: index === 0 ? "#0f7b4c" : "#7c3aed",
    });
  });
  if (plant.dhw) {
    series.push({
      id: "dhw",
      assetId: plant.dhw.id,
      attribute: ATTR.temperature,
      label: "ГВС",
      color: "#0891b2",
    });
  }
  return series;
}

export function datapointQuery(fromMs: number, toMs: number): Record<string, unknown> {
  return {
    type: "lttb",
    fromTimestamp: fromMs,
    toTimestamp: toMs,
    amountOfPoints: 240,
  };
}

export function parseDatapoints(body: unknown): ChartPoint[] {
  if (!Array.isArray(body)) return [];
  const points: ChartPoint[] = [];
  for (const item of body) {
    if (Array.isArray(item) && item.length >= 2) {
      const t = num(item[0], NaN);
      const v = num(item[1], NaN);
      if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const t = num(row.x ?? row.timestamp ?? row.t, NaN);
    const v = num(row.y ?? row.value ?? row.v, NaN);
    if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
  }
  return points.sort((a, b) => a.t - b.t);
}

export function formatTemp(value: number): string {
  return `${value.toFixed(1)}°`;
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Медленная «погода», чтобы график улицы не был прямой линией. */
export function seasonalOutdoor(now: number): number {
  const day = (now % 86_400_000) / 86_400_000;
  return round1(-4 + Math.sin(day * Math.PI * 2) * 6);
}

export function demoPlant(now = Date.now()): Plant {
  return {
    id: "plant-demo",
    name: PLANT_NAME,
    online: true,
    outdoorTemperature: seasonalOutdoor(now),
    alarmActive: false,
    alarmText: "",
    journal: [{ t: now - 3_600_000, level: "info", text: "Кабинет подключён к демо-контуру" }],
    boiler: {
      id: "boiler-demo",
      name: "Котёл",
      status: "heating",
      supplyTemperature: 58,
      returnTemperature: 41,
      flame: true,
      enabled: true,
      maxSupplySetpoint: 75,
    },
    circuits: [
      {
        id: "circuit-rad",
        name: "Радиаторы",
        roomTemperature: 20.6,
        flowTemperature: 48,
        setpoint: 22,
        mode: "comfort",
        pumpOn: true,
      },
      {
        id: "circuit-floor",
        name: "Тёплый пол",
        roomTemperature: 23.1,
        flowTemperature: 33,
        setpoint: 24,
        mode: "comfort",
        pumpOn: true,
      },
    ],
    dhw: {
      id: "dhw-demo",
      name: "ГВС",
      temperature: 49,
      setpoint: 55,
      mode: "comfort",
      pumpOn: true,
    },
  };
}

/** Прогон модели назад, чтобы на графике сразу была история, а не одна точка. */
export function simulateHistory(plant: Plant, hours: number, stepMin: number, now = Date.now()): Plant[] {
  const steps = Math.max(1, Math.round((hours * 60) / stepMin));
  let cursor = plant;
  const frames: Plant[] = [];
  const start = now - steps * stepMin * 60_000;
  for (let i = 0; i < steps; i += 1) {
    cursor = stepSimulation(cursor, stepMin, start + (i + 1) * stepMin * 60_000);
    frames.push(cursor);
  }
  return frames;
}

export interface MetaFlags {
  read?: boolean;
  write?: boolean;
  store?: boolean;
  label?: string;
}

/** Тело атрибута в том виде, в каком его принимает Manager. */
export function attributeBody(type: string, value: unknown, flags: MetaFlags = {}): Record<string, unknown> {
  const meta: Record<string, Array<{ name: string; value: unknown }>> = {};
  if (flags.read) meta.accessRestrictedRead = [{ name: "accessRestrictedRead", value: true }];
  if (flags.write) meta.accessRestrictedWrite = [{ name: "accessRestrictedWrite", value: true }];
  if (flags.store) meta.storeDataPoints = [{ name: "storeDataPoints", value: true }];
  if (flags.label) meta.label = [{ name: "label", value: flags.label }];
  return { type, value, meta };
}

export function demoAssetTree(): Array<Record<string, unknown>> {
  const plant: Record<string, unknown> = {
    name: PLANT_NAME,
    type: "ThingAsset",
    attributes: {
      [ATTR.kind]: attributeBody("text", "plant", { read: true, label: "Роль" }),
      [ATTR.outdoor]: attributeBody("number", seasonalOutdoor(Date.now()), { read: true, store: true, label: "Улица" }),
      [ATTR.online]: attributeBody("boolean", true, { read: true, label: "На связи" }),
      [ATTR.alarmActive]: attributeBody("boolean", false, { read: true, label: "Авария" }),
      [ATTR.alarmText]: attributeBody("text", "", { read: true, label: "Текст аварии" }),
      [ATTR.journal]: attributeBody("text", "[]", { read: true, label: "Журнал" }),
    },
  };
  const boiler: Record<string, unknown> = {
    name: "Котёл",
    type: "ThingAsset",
    attributes: {
      [ATTR.kind]: attributeBody("text", "boiler", { read: true }),
      [ATTR.status]: attributeBody("text", "heating", { read: true, label: "Статус" }),
      [ATTR.supply]: attributeBody("number", 58, { read: true, store: true, label: "Подача" }),
      [ATTR.returnTemp]: attributeBody("number", 41, { read: true, store: true, label: "Обратка" }),
      [ATTR.flame]: attributeBody("boolean", true, { read: true, label: "Горелка" }),
      [ATTR.enabled]: attributeBody("boolean", true, { read: true, write: true, label: "Котёл включён" }),
      [ATTR.maxSupply]: attributeBody("number", 75, { read: true, write: true, store: true, label: "Предел подачи" }),
    },
  };
  const radiators: Record<string, unknown> = {
    name: "Радиаторы",
    type: "ThingAsset",
    attributes: {
      [ATTR.kind]: attributeBody("text", "circuit", { read: true }),
      [ATTR.room]: attributeBody("number", 20.6, { read: true, store: true, label: "Помещение" }),
      [ATTR.flow]: attributeBody("number", 48, { read: true, store: true, label: "Подача контура" }),
      [ATTR.setpoint]: attributeBody("number", 22, { read: true, write: true, store: true, label: "Уставка" }),
      [ATTR.mode]: attributeBody("text", "comfort", { read: true, write: true, label: "Режим" }),
      [ATTR.pump]: attributeBody("boolean", true, { read: true, label: "Насос" }),
    },
  };
  const floor: Record<string, unknown> = {
    name: "Тёплый пол",
    type: "ThingAsset",
    attributes: {
      [ATTR.kind]: attributeBody("text", "circuit", { read: true }),
      [ATTR.room]: attributeBody("number", 23.1, { read: true, store: true, label: "Помещение" }),
      [ATTR.flow]: attributeBody("number", 33, { read: true, store: true, label: "Подача контура" }),
      [ATTR.setpoint]: attributeBody("number", 24, { read: true, write: true, store: true, label: "Уставка" }),
      [ATTR.mode]: attributeBody("text", "comfort", { read: true, write: true, label: "Режим" }),
      [ATTR.pump]: attributeBody("boolean", true, { read: true, label: "Насос" }),
    },
  };
  const dhw: Record<string, unknown> = {
    name: "ГВС",
    type: "ThingAsset",
    attributes: {
      [ATTR.kind]: attributeBody("text", "dhw", { read: true }),
      [ATTR.temperature]: attributeBody("number", 49, { read: true, store: true, label: "Температура" }),
      [ATTR.setpoint]: attributeBody("number", 55, { read: true, write: true, store: true, label: "Уставка" }),
      [ATTR.mode]: attributeBody("text", "comfort", { read: true, write: true, label: "Режим" }),
      [ATTR.pump]: attributeBody("boolean", true, { read: true, label: "Насос" }),
    },
  };
  return [plant, boiler, radiators, floor, dhw];
}
