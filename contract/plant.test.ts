import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTR,
  applyControls,
  applyWrite,
  attributeBody,
  datapointQuery,
  demoPlant,
  parseDatapoints,
  parsePlant,
  stepSimulation,
  targetTemperature,
  type RawAsset,
} from "./plant.ts";

function asset(id: string, name: string, parentId: string | null, attributes: Record<string, unknown>): RawAsset {
  const mapped: RawAsset["attributes"] = {};
  for (const [key, value] of Object.entries(attributes)) {
    mapped[key] = { value };
  }
  return { id, name, parentId, type: "ThingAsset", attributes: mapped };
}

test("режим эконом снижает цель, выключенный контур тепла не просит", () => {
  assert.equal(targetTemperature("comfort", 22, "circuit"), 22);
  assert.equal(targetTemperature("eco", 22, "circuit"), 19);
  assert.equal(targetTemperature("antifreeze", 22, "circuit"), 8);
  assert.equal(targetTemperature("off", 22, "circuit"), null);
  assert.equal(targetTemperature("eco", 55, "dhw"), 47);
});

test("дерево активов собирается в котельную по cabinetKind и parentId", () => {
  const plant = parsePlant([
    asset("p", "Дом", null, { [ATTR.kind]: "plant", [ATTR.outdoor]: -5, [ATTR.online]: true, [ATTR.journal]: "[]" }),
    asset("b", "Котёл", "p", {
      [ATTR.kind]: "boiler",
      [ATTR.status]: "standby",
      [ATTR.enabled]: true,
      [ATTR.maxSupply]: 70,
      [ATTR.supply]: 40,
      [ATTR.returnTemp]: 30,
      [ATTR.flame]: false,
    }),
    asset("c", "Радиаторы", "p", {
      [ATTR.kind]: "circuit",
      [ATTR.room]: 19,
      [ATTR.flow]: 35,
      [ATTR.setpoint]: 22,
      [ATTR.mode]: "comfort",
      [ATTR.pump]: false,
    }),
    asset("other", "Чужой контур", "elsewhere", { [ATTR.kind]: "circuit", [ATTR.setpoint]: 99 }),
  ]);
  assert.ok(plant);
  assert.equal(plant?.circuits.length, 1);
  assert.equal(plant?.circuits[0].setpoint, 22);
  assert.equal(plant?.outdoorTemperature, -5);
  assert.equal(plant?.dhw, null);
});

test("шаг модели греет помещение к уставке и не затирает саму уставку", () => {
  const start = demoPlant(1_700_000_000_000);
  start.circuits[0].roomTemperature = 18;
  start.circuits[0].setpoint = 22;
  const next = stepSimulation(start, 30, 1_700_000_000_000);
  assert.ok(next.circuits[0].roomTemperature > 18);
  assert.equal(next.circuits[0].setpoint, 22);
  assert.equal(next.boiler.flame, true);
  assert.equal(next.boiler.status, "heating");
});

test("выключенный котёл на морозе поднимает аварию", () => {
  const start = demoPlant(1_700_000_000_000);
  start.boiler.enabled = false;
  start.outdoorTemperature = -8;
  const next = stepSimulation(start, 1, 1_700_000_000_000);
  assert.equal(next.alarmActive, true);
  assert.match(next.alarmText, /выключен/i);
  assert.equal(next.journal[0].level, "alarm");
});

test("уставки с сервера подхватываются, измеренная температура остаётся локальной", () => {
  const local = demoPlant();
  local.circuits[0].roomTemperature = 19;
  const remote = demoPlant();
  remote.circuits[0].setpoint = 24;
  remote.circuits[0].roomTemperature = 99;
  const { plant, notes } = applyControls(local, remote);
  assert.equal(plant.circuits[0].setpoint, 24);
  assert.equal(plant.circuits[0].roomTemperature, 19);
  assert.match(notes[0].text, /24/);
});

test("запись уставки сразу видна на карточке и зажимается в допустимый диапазон", () => {
  const plant = applyWrite(demoPlant(), { id: "circuit-rad", name: ATTR.setpoint, value: 100 });
  assert.equal(plant.circuits[0].setpoint, 30);
});

test("разбор точек графика понимает форматы OpenRemote", () => {
  const points = parseDatapoints([
    { x: 10, y: 1 },
    { timestamp: 20, value: 2 },
    [30, 3],
  ]);
  assert.deepEqual(points, [
    { t: 10, v: 1 },
    { t: 20, v: 2 },
    { t: 30, v: 3 },
  ]);
  assert.equal(datapointQuery(1, 2).type, "lttb");
});

test("атрибут для Manager содержит флаги ограниченного доступа и историю", () => {
  const body = attributeBody("number", 21, { read: true, write: true, store: true, label: "Уставка" });
  const meta = body.meta as Record<string, unknown[]>;
  assert.ok(meta.accessRestrictedWrite);
  assert.ok(meta.storeDataPoints);
  assert.equal(body.value, 21);
});
