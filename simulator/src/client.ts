/**
 * Тонкий клиент Manager и Keycloak.
 * Те же пути использует личный кабинет, только от имени администратора:
 * симулятор создаёт realm, пользователя и активы, затем пишет измерения.
 */

export class OpenRemote {
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
        last = `HTTP ${response.status} ${await response.text()}`;
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      console.log(`Жду Manager, попытка ${i}/${attempts}: ${last}`);
      await delay(5000);
    }
    throw new Error(`Manager недоступен: ${last}`);
  }

  async adminToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: "openremote",
      grant_type: "password",
      username: process.env.OR_ADMIN_USER || "admin",
      password: process.env.OR_ADMIN_PASSWORD || "secret",
    });
    const response = await fetch(`${this.keycloakUrl}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`Токен администратора: HTTP ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { access_token: string };
    return json.access_token;
  }

  async keycloakAdminToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: "admin-cli",
      grant_type: "password",
      username: process.env.OR_ADMIN_USER || "admin",
      password: process.env.OR_ADMIN_PASSWORD || "secret",
    });
    const response = await fetch(`${this.keycloakUrl}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`Токен admin-cli: HTTP ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { access_token: string };
    return json.access_token;
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

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
