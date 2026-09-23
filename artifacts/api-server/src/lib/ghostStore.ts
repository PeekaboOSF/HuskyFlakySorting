import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  eventsTable,
  ordersTable,
  paymentCardsTable,
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
    if (existing.shopName !== "Haskibotrain") {
      await db.update(shopSettingsTable).set({ shopName: "Haskibotrain", updatedAt: new Date() }).where(eq(shopSettingsTable.id, existing.id));
    }
    await seedHaskibotrainProducts();
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

  await seedHaskibotrainProducts();
  return created!;
}

async function seedHaskibotrainProducts(): Promise<void> {
  const [demo] = await db.select().from(productsTable).where(eq(productsTable.name, "GHOST Starter Pack")).limit(1);
  if (demo?.active) {
    await db.update(productsTable).set({ active: false, updatedAt: new Date() }).where(eq(productsTable.id, demo.id));
  }
  const positions = [
    { name: "кристаллл · 1 г", price: 5200 },
    { name: "кристаллл · 2 г", price: 7200 },
    { name: "мед премиум · 1 г", price: 6400 },
    { name: "meou · 1 г", price: 4000 },
    { name: "meou · 2 г", price: 6300 },
  ];
  for (const position of positions) {
    const [found] = await db.select({ id: productsTable.id }).from(productsTable).where(eq(productsTable.name, position.name)).limit(1);
    if (!found) {
      await db.insert(productsTable).values({
        name: position.name,
        description: "Выдача текстовой инструкции после ручного подтверждения оплаты.",
        price: position.price,
        currency: "RUB",
        deliveryType: "text",
        deliveryLabel: "Инструкция в Telegram",
        deliveryPayloadEncrypted: encrypt(`Инструкция для позиции «${position.name}» ещё не загружена владельцем. Используйте /setcontent ${position.name} после привязки владельца.`),
        inventory: 999,
        active: true,
      });
    }
  }
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

export const SHOP_CITIES = ["Большеречье", "Омск", "Любинo", "Калачинск"] as const;
export type ShopCity = typeof SHOP_CITIES[number];

export function isShopCity(value: string): value is ShopCity {
  return (SHOP_CITIES as readonly string[]).includes(value);
}

let paymentCardClaimQueue = Promise.resolve();

export async function claimNextPaymentCard() {
  let result: typeof paymentCardsTable.$inferSelect | undefined;
  const task = paymentCardClaimQueue.then(async () => {
    await db.transaction(async (tx) => {
      const [settings] = await tx.select().from(shopSettingsTable).limit(1);
      if (!settings) return;
      const cards = await tx.select().from(paymentCardsTable)
        .where(eq(paymentCardsTable.active, true))
        .orderBy(asc(paymentCardsTable.id));
      if (!cards.length) return;
      const index = settings.paymentCardCursor % cards.length;
      result = cards[index];
      await tx.update(shopSettingsTable).set({
        paymentCardCursor: (index + 1) % cards.length,
        updatedAt: new Date(),
      }).where(eq(shopSettingsTable.id, settings.id));
      await tx.update(paymentCardsTable).set({
        usageCount: sql`${paymentCardsTable.usageCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(paymentCardsTable.id, cards[index]!.id));
    });
  });
  paymentCardClaimQueue = task.then(() => undefined, () => undefined);
  await task;
  return result;
}

export async function getSupportTickets() {
  return db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.updatedAt)).limit(50);
}