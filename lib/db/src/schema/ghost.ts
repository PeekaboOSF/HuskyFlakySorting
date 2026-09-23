import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const shopSettingsTable = pgTable("shop_settings", {
  id: serial("id").primaryKey(),
  shopName: text("shop_name").notNull().default("GHOST DIGITAL"),
  paymentInstructions: text("payment_instructions").notNull().default("Оплата вручную. После перевода нажмите «Я оплатил»."),
  supportHandle: text("support_handle").notNull().default("@support"),
  botStatus: text("bot_status").notNull().default("setup_required"),
  ownerTelegramIdEncrypted: text("owner_telegram_id_encrypted"),
  setupCodeHash: text("setup_code_hash"),
  setupCodeIssuedAt: timestamp("setup_code_issued_at", { withTimezone: true }),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  paymentCardCursor: integer("payment_card_cursor").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const productsTable = pgTable("shop_products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  price: doublePrecision("price").notNull(),
  currency: text("currency").notNull().default("RUB"),
  deliveryType: text("delivery_type").notNull(),
  deliveryLabel: text("delivery_label").notNull(),
  deliveryPayloadEncrypted: text("delivery_payload_encrypted").notNull(),
  inventory: integer("inventory").notNull().default(1),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ordersTable = pgTable("shop_orders", {
  id: serial("id").primaryKey(),
  customerNameEncrypted: text("customer_name_encrypted").notNull(),
  usernameEncrypted: text("username_encrypted"),
  telegramIdEncrypted: text("telegram_id_encrypted").notNull(),
  telegramLookupHash: text("telegram_lookup_hash").notNull(),
  productId: integer("product_id").notNull(),
  productNameEncrypted: text("product_name_encrypted").notNull(),
  amount: doublePrecision("amount").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull().default("pending"),
  deliveryType: text("delivery_type").notNull(),
  city: text("city").notNull().default("Не выбран"),
  paymentDetailsEncrypted: text("payment_details_encrypted"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  deliveryCount: integer("delivery_count").notNull().default(0),
  decisionNoteEncrypted: text("decision_note_encrypted"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const eventsTable = pgTable("shop_events", {
  id: serial("id").primaryKey(),
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const supportTicketsTable = pgTable("shop_support_tickets", {
  id: serial("id").primaryKey(),
  customerNameEncrypted: text("customer_name_encrypted").notNull(),
  usernameEncrypted: text("username_encrypted"),
  telegramLookupHash: text("telegram_lookup_hash").notNull(),
  telegramIdEncrypted: text("telegram_id_encrypted").notNull().default(""),
  topic: text("topic").notNull(),
  status: text("status").notNull().default("open"),
  lastMessageEncrypted: text("last_message_encrypted").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const paymentCardsTable = pgTable("shop_payment_cards", {
  id: serial("id").primaryKey(),
  label: text("label").notNull(),
  detailsEncrypted: text("details_encrypted").notNull(),
  active: boolean("active").notNull().default(true),
  usageCount: integer("usage_count").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ShopSettings = typeof shopSettingsTable.$inferSelect;
export type Product = typeof productsTable.$inferSelect;
export type Order = typeof ordersTable.$inferSelect;
export type ShopEvent = typeof eventsTable.$inferSelect;
export type SupportTicket = typeof supportTicketsTable.$inferSelect;
export type PaymentCard = typeof paymentCardsTable.$inferSelect;