/**
 * Тонкий клиент Manager и Keycloak.
 * Те же пути использует личный кабинет, только от имени администратора:
 * симулятор создаёт realm, пользователя и активы, затем пишет измерения.
 */

export class OpenRemote {
  private cachedToken: { value: string; until: number } | null = null;

  constructor(
    private readonly managerUrl: string,
    private readonly keycloakUrl: string,
  ) {}

  async waitUntilReady(attempts = 60): Promise<void> {
    let last = "Manager ещё не ответил";
    for (let i = 1; i <= attempts; i += 1) {
      try {
        const token = await this.adminToken();
        const response = await fetch(`${this.managerUrl}/api/master/realm`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) return;
        const text = await response.text();
        if ((response.status === 401 || response.status === 403) && (await this.allowPasswordGrant())) {
          this.cachedToken = null;
          last = "Включил прямой вход для клиента openremote, повторяю";
        } else {
          last = `HTTP ${response.status} ${text}`;
        }
      } catch (error) {
        last = describeError(error);
        if (isBadPassword(last)) {
          throw new Error(
            `OpenRemote не принял пароль администратора. Впишите верный OR_ADMIN_PASSWORD в файл .env. Подробность: ${last}`,
          );
        }
        if (isBadCertificate(last)) {
          throw new Error(
            `Сертификат OpenRemote самоподписанный. В .env должна быть строка NODE_TLS_REJECT_UNAUTHORIZED=0. Подробность: ${last}`,
          );
        }
      }
      console.log(`Жду Manager, попытка ${i}/${attempts}: ${last}`);
      await delay(5000);
    }
    throw new Error(`Manager недоступен: ${last}`);
  }

  async adminToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.until > Date.now()) return this.cachedToken.value;
    const username = process.env.OR_ADMIN_USER || "admin";
    const password = process.env.OR_ADMIN_PASSWORD || "secret";
    try {
      return this.remember(await this.passwordGrant("master", "openremote", username, password));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("unauthorized_client")) throw error;
    }
    console.log("Клиент openremote не принимает пароль напрямую, вхожу через admin-cli");
    return this.remember(await this.passwordGrant("master", "admin-cli", username, password));
  }

  async keycloakAdminToken(): Promise<string> {
    const username = process.env.OR_ADMIN_USER || "admin";
    const password = process.env.OR_ADMIN_PASSWORD || "secret";
    return this.passwordGrant("master", "admin-cli", username, password);
  }

  private remember(token: string): string {
    this.cachedToken = { value: token, until: Date.now() + 30_000 };
    return token;
  }

  /** Токен области. У OpenRemote 1.31 токен master не действует на /api/boiler. */
  async realmPassword(realm: string, username: string, password: string): Promise<string> {
    return this.passwordGrant(realm, "openremote", username, password);
  }

  /**
   * ok — пароль принят.
   * bad-password — пользователь есть, пароль не тот.
   * no-grant — клиент не принимает вход по паролю.
   */
  async checkRealmPassword(
    realm: string,
    username: string,
    password: string,
  ): Promise<"ok" | "bad-password" | "no-grant"> {
    try {
      await this.realmPassword(realm, username, password);
      return "ok";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("unauthorized_client")) return "no-grant";
      if (isBadPassword(message)) return "bad-password";
      throw error;
    }
  }

  private async passwordGrant(realm: string, clientId: string, username: string, password: string): Promise<string> {
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: "password",
      username,
      password,
    });
    const response = await fetch(`${this.keycloakUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`Токен ${realm}/${clientId}: HTTP ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { access_token: string };
    return json.access_token;
  }

  /** На боевом Keycloak у клиента openremote часто выключен Direct access grants. */
  private async allowPasswordGrant(): Promise<boolean> {
    try {
      const admin = await this.keycloakAdminToken();
      const list = await this.keycloakJson<Array<Record<string, unknown>>>(
        admin,
        "GET",
        "/admin/realms/master/clients?clientId=openremote",
      );
      const client = list[0];
      if (!client?.id || client.directAccessGrantsEnabled === true) return false;
      await this.keycloakJson(admin, "PUT", `/admin/realms/master/clients/${String(client.id)}`, {
        ...client,
        directAccessGrantsEnabled: true,
      });
      console.log("Для клиента openremote включён прямой вход по паролю");
      return true;
    } catch (error) {
      console.log(`Не удалось включить прямой вход: ${describeError(error)}`);
      return false;
    }
  }

  private async keycloakJson<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.keycloakUrl}${path}`, {
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

  async request(token: string, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.managerUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async json<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.request(token, method, path, body);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${method} ${path} → HTTP ${response.status} ${text}`);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code || cause?.message;
  return detail ? `${error.message}: ${detail}` : error.message;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBadPassword(message: string): boolean {
  if (message.includes("unauthorized_client")) return false;
  return /HTTP 401|invalid_grant|Invalid user credentials/i.test(message);
}

function isBadCertificate(message: string): boolean {
  return /CERT_|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO/i.test(message);
}
