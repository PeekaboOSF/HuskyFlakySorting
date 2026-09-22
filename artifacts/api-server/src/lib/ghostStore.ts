import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  eventsTable,
  ordersTable,
  productsTable,
  shopSettingsTable,
  supportTicketsTable,
  type Product,
  type ShopSettings,
} from "@workspace/db";
import { encrypt, hashSetupCode, randomSetupCode } from "./ghostSecurity";
import { logger } from "./logger";

let setupCodeLogged = false;

export async function ensureShopInitialized(): Promise<ShopSettings> {
  const [existing] = await db.select().from(shopSettingsTable).limit(1);
  if (existing) {
    if (!existing.setupCodeHash && !existing.ownerTelegramIdEncrypted) {
      const code = randomSetupCode();
      await db.update(shopSettingsTable).set({
        setupCodeHash: hashSetupCode(code),
        setupCodeIssuedAt: new Date(),
        botStatus: "setup_required",
        updatedAt: new Date(),
      }).where(eq(shopSettingsTable.id, existing.id));
      logger.warn({ setupCode: code }, "Ghost owner setup code generated; enter /setup <code> in Telegram");
      setupCodeLogged = true;
      return (await db.select().from(shopSettingsTable).where(eq(shopSettingsTable.id, existing.id)).limit(1))[0]!;
    }
    if (!setupCodeLogged && existing.setupCodeIssuedAt && !existing.ownerTelegramIdEncrypted) {
      logger.warn("Ghost owner setup code is already generated; use the code from the first startup log");
      setupCodeLogged = true;
    }
    return existing;
  }

  const code = randomSetupCode();
  const [created] = await db.insert(shopSettingsTable).values({
    setupCodeHash: hashSetupCode(code),
    setupCodeIssuedAt: new Date(),
    botStatus: process.env.BOT_TOKEN ? "setup_required" : "paused",
  }).returning();
  logger.warn({ setupCode: code }, "Ghost owner setup code generated; enter /setup <code> in Telegram");
  setupCodeLogged = true;

  const [count] = await db.select({ count: sql<number>`count(*)` }).from(productsTable);
  if (Number(count?.count ?? 0) === 0) {
    await db.insert(productsTable).values({
      name: "GHOST Starter Pack",
      description: "Демо-позиция для проверки каталога. Её можно изменить или архивировать в owner-панели.",
      price: 0,
      currency: "RUB",
      deliveryType: "text",
      deliveryLabel: "Текстовое сообщение",
      deliveryPayloadEncrypted: encrypt("Добро пожаловать в GHOST. Замените этот демо-товар на свою позицию."),
      inventory: 999,
      active: true,
    });
  }
  return created!;
}

export async function logShopEvent(eventType: string, summary: string): Promise<void> {
  await db.insert(eventsTable).values({ eventType, summary: summary.slice(0, 240) });
}

export function toProductView(product: Product) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: product.price,
    currency: product.currency,
    deliveryType: product.deliveryType,
    deliveryLabel: product.deliveryLabel,
    inventory: product.inventory,
    active: product.active,
    createdAt: product.createdAt,
  };
}

export async function isOwnerTelegramId(telegramId: string): Promise<boolean> {
  const settings = await ensureShopInitialized();
  if (!settings.ownerTelegramIdEncrypted) return false;
  return (await import("./ghostSecurity")).decrypt(settings.ownerTelegramIdEncrypted) === telegramId;
}

export async function listRecentOrders(limit = 50) {
  return db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(limit);
}

export async function getOrder(id: number) {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id)).limit(1);
  return order;
}

export async function getProduct(id: number) {
  const [product] = await db.select().from(productsTable).where(eq(productsTable.id, id)).limit(1);
  return product;
}

export async function getPendingOrderForUser(productId: number, telegramLookupHash: string) {
  const [order] = await db.select().from(ordersTable).where(and(
    eq(ordersTable.productId, productId),
    eq(ordersTable.telegramLookupHash, telegramLookupHash),
    eq(ordersTable.status, "pending"),
  )).orderBy(desc(ordersTable.createdAt)).limit(1);
  return order;
}

export async function getSettings(): Promise<ShopSettings> {
  return ensureShopInitialized();
}

export async function getSupportTickets() {
  return db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.updatedAt)).limit(50);
}