/**
 * Демо-контур котельной.
 *
 * 1. Создаёт realm, оператора и дерево активов, если их ещё нет.
 * 2. Разрешает вход кабинета с localhost и с порта разработки 9000.
 * 3. Каждые несколько секунд читает уставки и пишет измерения.
 *    Уставки этот процесс не перезаписывает: их меняет человек в кабинете.
 */
import {
  PLANT_NAME,
  REALM,
  applyControls,
  demoAssetTree,
  measurementWrites,
  parsePlant,
  sameWrite,
  unwrapAssets,
  simulateHistory,
  stepSimulation,
  type AttributeWrite,
  type Plant,
  type RawAsset,
} from "../../contract/plant.ts";
import { OpenRemote, delay } from "./client.ts";

const REALM_NAME = process.env.CABINET_REALM || REALM;
const PLANT = process.env.PLANT_NAME || PLANT_NAME;
const OPERATOR = process.env.OPERATOR_USER || "operator";
const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD || "operator";
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS || 5000);
const STEP_MINUTES = Number(process.env.SIM_STEP_MINUTES || 1);
const MANAGER_URL = (process.env.MANAGER_URL || "http://manager:8080").replace(/\/$/, "");
const KEYCLOAK_URL = (process.env.KEYCLOAK_URL || `${MANAGER_URL}/auth`).replace(/\/$/, "");

const or = new OpenRemote(MANAGER_URL, KEYCLOAK_URL);

async function main(): Promise<void> {
  console.log(`Симулятор котельной → ${MANAGER_URL}, realm ${REALM_NAME}`);
  await or.waitUntilReady();
  const token = await or.adminToken();
  await ensureRealm(token);
  await ensureRedirects();
  const userId = await ensureOperator(token);
  const assets = await ensureAssets(token);
  await ensureLinks(token, userId, assets.map((asset) => asset.id));
  if (process.env.SIM_BACKFILL !== "false") {
    await backfill(token, assets);
  }
  if (process.env.SIM_LOOP === "true") {
    await loop(token);
    return;
  }
  console.log("Данные заведены. Цикл измерений выключен: живой контроллер пишет температуры сам. Демо-контур включается переменной SIM_LOOP=true.");
}

async function ensureRealm(token: string): Promise<void> {
  const realms = await or.json<Array<{ name?: string }>>(token, "GET", "/api/master/realm");
  if (realms.some((realm) => realm.name === REALM_NAME)) {
    console.log(`Realm ${REALM_NAME} уже есть`);
    return;
  }
  await or.json(token, "POST", "/api/master/realm", {
    name: REALM_NAME,
    displayName: "Котельная",
    enabled: true,
  });
  console.log(`Создан realm ${REALM_NAME}`);
  await delay(2000);
}

async function ensureRedirects(): Promise<void> {
  const extra = (process.env.REDIRECT_URIS || "https://212.22.82.167/*,http://localhost:9000/*,http://localhost/*,https://localhost/*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  try {
    const admin = await or.keycloakAdminToken();
    const list = await keycloak<Array<Record<string, unknown>>>(
      admin,
      "GET",
      `/admin/realms/${REALM_NAME}/clients?clientId=openremote`,
    );
    const client = list[0];
    if (!client?.id) {
      console.log("Клиент openremote в Keycloak не найден, редиректы не обновлены");
      return;
    }
    const redirectUris = unique([...(asStrings(client.redirectUris)), ...extra]);
    const webOrigins = unique([...(asStrings(client.webOrigins)), "+"]);
    await keycloak(admin, "PUT", `/admin/realms/${REALM_NAME}/clients/${String(client.id)}`, {
      ...client,
      redirectUris,
      webOrigins,
      standardFlowEnabled: true,
      directAccessGrantsEnabled: true,
      publicClient: true,
    });
    console.log(`Редиректы кабинета: ${redirectUris.join(", ")}`);
  } catch (error) {
    console.log(`Не удалось обновить редиректы Keycloak: ${error instanceof Error ? error.message : error}`);
  }
}

async function ensureOperator(token: string): Promise<string> {
  const existing = await findUser(token, OPERATOR);
  const userId = existing ?? (await createUser(token));
  if (!existing || process.env.RESET_OPERATOR_PASSWORD === "true") {
    await or.request(token, "PUT", `/api/master/user/${REALM_NAME}/reset-password/${userId}`, {
      type: "password",
      value: OPERATOR_PASSWORD,
      temporary: false,
    });
  }
  await or.request(token, "PUT", `/api/master/user/${REALM_NAME}/userRealmRoles/${userId}`, ["restricted_user"]);
  const roles = await clientRoles(token);
  const wanted = ["read:assets", "write:attributes", "read:alarms"].filter((role) => roles.includes(role));
  if (!wanted.includes("read:assets") || !wanted.includes("write:attributes")) {
    throw new Error(`В клиенте openremote нет нужных ролей. Есть: ${roles.join(", ")}`);
  }
  await or.request(token, "PUT", `/api/master/user/${REALM_NAME}/userRoles/${userId}/openremote`, wanted);
  console.log(`Оператор ${OPERATOR} готов, роли: ${wanted.join(", ")}`);
  return userId;
}

async function findUser(token: string, username: string): Promise<string | null> {
  const queries = [
    { realm: { name: REALM_NAME }, username },
    { realmPredicate: { name: REALM_NAME }, usernames: [username] },
  ];
  for (const query of queries) {
    try {
      const users = await or.json<Array<{ id?: string; username?: string }>>(token, "POST", "/api/master/user/query", query);
      const found = users.find((user) => user.username === username && user.id);
      if (found?.id) return found.id;
    } catch {
      // Следующая форма запроса. Схема UserQuery между версиями чуть отличается.
    }
  }
  try {
    const admin = await or.keycloakAdminToken();
    const users = await keycloak<Array<{ id: string }>>(
      admin,
      "GET",
      `/admin/realms/${REALM_NAME}/users?username=${encodeURIComponent(username)}&exact=true`,
    );
    return users[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function createUser(token: string): Promise<string> {
  const created = await or.json<{ id: string }>(token, "POST", `/api/master/user/${REALM_NAME}/users`, {
    username: OPERATOR,
    firstName: "Оператор",
    lastName: "Котельной",
    email: "operator@localhost",
    enabled: true,
  });
  console.log(`Создан пользователь ${OPERATOR}`);
  return created.id;
}

async function clientRoles(token: string): Promise<string[]> {
  const roles = await or.json<Array<{ name?: string }>>(token, "GET", `/api/master/user/${REALM_NAME}/openremote/roles`);
  return roles.map((role) => role.name).filter((name): name is string => Boolean(name));
}

async function ensureAssets(token: string): Promise<RawAsset[]> {
  const current = unwrapAssets(await or.json<unknown>(token, "POST", `/api/${REALM_NAME}/asset/query`, {}));
  const parsed = parsePlant(current);
  if (parsed) {
    console.log(`Активы котельной уже есть: ${parsed.name}`);
    return current;
  }
  const [plant, boiler, radiators, floor, dhw] = demoAssetTree();
  plant.name = PLANT;
  const plantAsset = await or.json<RawAsset>(token, "POST", `/api/${REALM_NAME}/asset`, plant);
  const children = [boiler, radiators, floor, dhw];
  for (const child of children) {
    await or.json(token, "POST", `/api/${REALM_NAME}/asset`, { ...child, parentId: plantAsset.id });
  }
  console.log(`Создано дерево активов «${PLANT}»`);
  return unwrapAssets(await or.json<unknown>(token, "POST", `/api/${REALM_NAME}/asset/query`, {}));
}

async function ensureLinks(token: string, userId: string, assetIds: string[]): Promise<void> {
  const links = assetIds.map((assetId) => ({ id: { realm: REALM_NAME, userId, assetId } }));
  const response = await or.request(token, "POST", `/api/${REALM_NAME}/asset/user/link`, links);
  if (!response.ok && response.status !== 409) {
    const text = await response.text();
    console.log(`Связь пользователя с активами: HTTP ${response.status} ${text}`);
  } else {
    console.log(`Оператор привязан к ${assetIds.length} активам`);
  }
}

async function backfill(token: string, assets: RawAsset[]): Promise<void> {
  const plant = parsePlant(assets);
  if (!plant) return;
  const frames = simulateHistory(plant, 6, 5);
  let stored = 0;
  for (const frame of frames) {
    const moment = frames.indexOf(frame);
    const ts = Date.now() - (frames.length - moment) * 5 * 60_000;
    for (const write of measurementWrites(frame)) {
      if (typeof write.value !== "number") continue;
      const response = await or.request(
        token,
        "PUT",
        `/api/${REALM_NAME}/asset/${write.id}/attribute/${write.name}/${ts}`,
        write.value,
      );
      if (response.status === 404 || response.status === 405) {
        console.log("Запись истории с меткой времени этим Manager не принята, график наберётся вживую");
        return;
      }
      if (!response.ok) {
        console.log(`История ${write.name}: HTTP ${response.status} ${await response.text()}`);
        return;
      }
      stored += 1;
    }
  }
  console.log(`В историю записано точек: ${stored}`);
}

async function loop(token: string): Promise<void> {
  let local = parsePlant(await loadAssets(token));
  if (!local) throw new Error("После наполнения котельная не читается");
  let previous = measurementWrites(local);
  console.log(`Контур запущен, шаг ${INTERVAL_MS} мс`);
  for (;;) {
    try {
      token = await or.adminToken();
      const remote = parsePlant(await loadAssets(token));
      if (!remote) throw new Error("Активы котельной пропали из realm");
      const applied = applyControls(local, remote);
      local = applied.plant;
      if (applied.notes.length) {
        local = { ...local, journal: [...applied.notes, ...local.journal].slice(0, 40) };
      }
      local = stepSimulation(local, STEP_MINUTES);
      const writes = measurementWrites(local).filter((write) => !previous.some((item) => sameWrite(item, write)));
      if (writes.length) await writeAttributes(token, writes);
      previous = measurementWrites(local);
    } catch (error) {
      console.log(`Шаг контура: ${error instanceof Error ? error.message : error}`);
    }
    await delay(INTERVAL_MS);
  }
}

async function loadAssets(token: string): Promise<RawAsset[]> {
  return unwrapAssets(await or.json<unknown>(token, "POST", `/api/${REALM_NAME}/asset/query`, {}));
}

async function writeAttributes(token: string, writes: AttributeWrite[]): Promise<void> {
  const response = await or.request(
    token,
    "PUT",
    `/api/${REALM_NAME}/asset/attributes`,
    writes.map((write) => ({ ref: { id: write.id, name: write.name }, value: write.value })),
  );
  if (!response.ok) {
    throw new Error(`Запись измерений HTTP ${response.status} ${await response.text()}`);
  }
}

async function keycloak<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${KEYCLOAK_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → HTTP ${response.status} ${text}`);
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
