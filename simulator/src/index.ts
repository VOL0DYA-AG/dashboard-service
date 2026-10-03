/**
 * Демо-контур котельной.
 *
 * 1. Создаёт realm, оператора и дерево активов, если их ещё нет.
 * 2. Разрешает вход с адреса кабинета (CABINET_URL).
 * 3. Если SIM_LOOP=true, каждые несколько секунд читает уставки и пишет измерения.
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
const SETUP_USER = "cabinet-setup";
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS || 5000);
const STEP_MINUTES = Number(process.env.SIM_STEP_MINUTES || 1);
const MANAGER_URL = (process.env.MANAGER_URL || "https://212.22.82.167").replace(/\/$/, "");
const KEYCLOAK_URL = (process.env.KEYCLOAK_URL || `${MANAGER_URL}/auth`).replace(/\/$/, "");

const or = new OpenRemote(MANAGER_URL, KEYCLOAK_URL);

async function main(): Promise<void> {
  const password = process.env.OR_ADMIN_PASSWORD || "";
  if (!password || password === "секрет-админа-этого-openremote") {
    throw new Error("Скопируйте .env.example в .env и впишите настоящий пароль администратора OpenRemote в OR_ADMIN_PASSWORD.");
  }
  console.log(`Настройка котельной → ${MANAGER_URL}, область ${REALM_NAME}, кабинет ${cabinetOrigin()}`);
  await or.waitUntilReady();
  await warnIfBrowserBlocked();
  const token = await or.adminToken();
  await ensureRealm(token);
  await ensureRedirects();
  const userId = await ensureOperator(token);
  const realmToken = await ensureRealmWriter(token);
  const assets = await ensureAssets(realmToken);
  await ensureLinks(realmToken, userId, cabinetAssetIds(assets));
  if (process.env.SIM_BACKFILL === "true") {
    await backfill(realmToken, assets);
  }
  if (process.env.SIM_LOOP === "true") {
    await loop(realmToken);
    return;
  }
  console.log("Данные заведены. Температуры скрипт не крутит: их будет писать контроллер котла.");
  console.log(`Кабинет: ${cabinetOrigin()}/cabinet/`);
  console.log(`Вход: ${OPERATOR} / пароль из OPERATOR_PASSWORD`);
  await warnIfBrowserBlocked();
}

async function ensureRealm(token: string): Promise<void> {
  const realms = await or.json<Array<{ name?: string }>>(token, "GET", "/api/master/realm");
  if (realms.some((realm) => realm.name === REALM_NAME)) {
    console.log(`Область ${REALM_NAME} уже есть`);
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

function cabinetAssetIds(assets: RawAsset[]): string[] {
  const plant = parsePlant(assets);
  if (!plant) return assets.map((asset) => asset.id);
  return [
    plant.id,
    plant.boiler.id,
    ...plant.circuits.map((circuit) => circuit.id),
    ...(plant.dhw ? [plant.dhw.id] : []),
  ];
}

function cabinetOrigin(): string {
  const raw = (process.env.CABINET_URL || "http://195.170.163.72:8090").trim();
  const withScheme = raw.includes("://") ? raw : `http://${raw}`;
  return new URL(withScheme).origin;
}

async function warnIfBrowserBlocked(): Promise<void> {
  const origin = cabinetOrigin();
  try {
    const response = await fetch(`${MANAGER_URL}/api/master/info`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    const allow = response.headers.get("access-control-allow-origin");
    if (allow === origin || allow === "*") {
      console.log(`OpenRemote пускает браузер с адреса ${origin}.`);
      return;
    }
    const text = (await response.text()).trim();
    console.log("");
    console.log(`ВНИМАНИЕ. Страница кабинета откроется, но данные из OpenRemote браузер не получит.`);
    console.log(`OpenRemote отклонил адрес ${origin}${text ? `: ${text}` : ""}.`);
    console.log("На сервере 212.22.82.167 у контейнера manager добавьте строку и перезапустите только его:");
    console.log(`OR_WEBSERVER_ALLOWED_ORIGINS=${origin}`);
    console.log("Если строка уже есть, допишите этот адрес через запятую. Знак * ставьте только один, без других адресов.");
    console.log("");
  } catch (error) {
    console.log(`Не удалось проверить допуск браузера: ${error instanceof Error ? error.message : error}`);
  }
}

async function ensureRedirects(): Promise<void> {
  const origin = cabinetOrigin();
  const extra = [
    `${origin}/*`,
    ...(process.env.REDIRECT_URIS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ];
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
    const redirectUris = unique([...(asStrings(client.redirectUris)), ...extra]).filter(isHttpRedirect);
    const webOrigins = unique([...(asStrings(client.webOrigins)), origin, "+"]);
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
  const userId = existing ?? (await createUser(token, OPERATOR, "Оператор", "Котельной", "operator@localhost"));
  if (!existing || process.env.RESET_OPERATOR_PASSWORD === "true") {
    await setPassword(token, userId, OPERATOR_PASSWORD);
  }
  await or.request(token, "PUT", `/api/master/user/${REALM_NAME}/userRealmRoles/${userId}`, ["restricted_user"]);
  const roles = await clientRoles(token);
  const wanted = ["read:assets", "write:attributes", "read:alarms"].filter((role) => roles.includes(role));
  if (!wanted.includes("read:assets") || !wanted.includes("write:attributes")) {
    throw new Error(`В клиенте openremote нет нужных ролей. Есть: ${roles.join(", ")}`);
  }
  await or.request(token, "PUT", `/api/master/user/${REALM_NAME}/userRoles/${userId}/openremote`, wanted);
  await confirmOperatorPassword(token, userId);
  console.log(`Оператор ${OPERATOR} готов, роли: ${wanted.join(", ")}`);
  return userId;
}

async function confirmOperatorPassword(token: string, userId: string): Promise<void> {
  const first = await or.checkRealmPassword(REALM_NAME, OPERATOR, OPERATOR_PASSWORD);
  if (first === "ok") {
    console.log(`Пароль ${OPERATOR} из .env подходит`);
    return;
  }
  if (first === "no-grant") {
    throw new Error(
      `Область ${REALM_NAME} не принимает вход по паролю. Клиент openremote должен разрешать Direct access grants.`,
    );
  }
  console.log(`Пароль ${OPERATOR} не подходит, записываю значение из .env заново`);
  await setPassword(token, userId, OPERATOR_PASSWORD);
  await delay(1000);
  const second = await or.checkRealmPassword(REALM_NAME, OPERATOR, OPERATOR_PASSWORD);
  if (second !== "ok") {
    throw new Error(
      `OpenRemote не принял пароль ${OPERATOR} после записи. В кабинет нужно входить этим пользователем в области ${REALM_NAME}, не паролем администратора.`,
    );
  }
  console.log(`Пароль ${OPERATOR} записан заново`);
}

/** Пользователь области boiler, которым можно создавать карточки. Токен администратора master туда не пускает. */
async function ensureRealmWriter(token: string): Promise<string> {
  const password = process.env.OR_ADMIN_PASSWORD || "";
  let userId = await findUser(token, SETUP_USER);
  if (!userId) {
    userId = await createUser(token, SETUP_USER, "Настройка", "Кабинета", "cabinet-setup@localhost");
  }
  await setPassword(token, userId, password);
  const roles = await clientRoles(token);
  const wanted = ["read:assets", "write:assets", "write:attributes"].filter((role) => roles.includes(role));
  if (!wanted.includes("read:assets") || !wanted.includes("write:assets")) {
    throw new Error(`В клиенте openremote нет роли записи карточек. Есть: ${roles.join(", ")}`);
  }
  const roleResponse = await or.request(token, "PUT", `/api/master/user/${REALM_NAME}/userRoles/${userId}/openremote`, wanted);
  if (!roleResponse.ok) {
    throw new Error(`Роли для карточек не записались: HTTP ${roleResponse.status} ${await roleResponse.text()}`);
  }
  await delay(1000);
  const check = await or.checkRealmPassword(REALM_NAME, SETUP_USER, password);
  if (check !== "ok") {
    throw new Error(`Не удалось войти в область ${REALM_NAME}, чтобы создать карточки котельной: ${check}`);
  }
  console.log(`Вход в область ${REALM_NAME} для карточек получен`);
  return or.realmPassword(REALM_NAME, SETUP_USER, password);
}

async function setPassword(token: string, userId: string, password: string): Promise<void> {
  const response = await or.request(token, "PUT", `/api/master/user/${REALM_NAME}/reset-password/${userId}`, {
    type: "password",
    value: password,
    temporary: false,
  });
  if (!response.ok) {
    throw new Error(`Пароль не записался: HTTP ${response.status} ${await response.text()}`);
  }
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

async function createUser(
  token: string,
  username: string,
  firstName: string,
  lastName: string,
  email: string,
): Promise<string> {
  const created = await or.json<{ id: string }>(token, "POST", `/api/master/user/${REALM_NAME}/users`, {
    username,
    firstName,
    lastName,
    email,
    enabled: true,
  });
  console.log(`Создан пользователь ${username}`);
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
      token = await or.realmPassword(REALM_NAME, SETUP_USER, process.env.OR_ADMIN_PASSWORD || "");
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

function isHttpRedirect(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
