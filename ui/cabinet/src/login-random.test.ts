import assert from "node:assert/strict";
import test from "node:test";
import { ensureLoginRandom, formatUuid } from "./login-random.ts";

test("запасной идентификатор похож на UUID", () => {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i + 1;
  const id = formatUuid(bytes);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("если randomUUID спрятан, вход получает замену", () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", { configurable: true, value: undefined });
  try {
    ensureLoginRandom();
    assert.match(crypto.randomUUID(), /^[0-9a-f-]{36}$/);
  } finally {
    Object.defineProperty(crypto, "randomUUID", { configurable: true, value: original });
  }
});
