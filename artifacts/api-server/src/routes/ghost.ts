import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  ApproveShopOrderParams,
  ClaimOwnerSetupBody,
  CreateShopProductBody,
  DeleteShopProductParams,
  GetSetupStatusResponse,
  GetShopDashboardResponse,
  GetShopSettingsResponse,
  ListShopEventsQueryParams,
  ListShopOrdersQueryParams,
  ListShopProductsResponse,
  ListShopSupportResponse,
  RejectShopOrderBody,
  RejectShopOrderParams,
  RedeliverShopOrderParams,
  ClaimOwnerSetupResponse,
  UpdateShopProductBody,
  UpdateShopProductParams,
  UpdateShopSettingsBody,
} from "@workspace/api-zod";
import {
  db,
  eventsTable,
  ordersTable,
  productsTable,
  shopSettingsTable,
  type Order,
} from "@workspace/db";
import {
  decrypt,
  encrypt,
  hashSetupCode,
  signOwnerSession,
  verifyOwnerSession,
} from "../lib/ghostSecurity";
import {
  ensureShopInitialized,
  getOrder,
  getProduct,
  getSettings,
  getSupportTickets,
  logShopEvent,
  toProductView,
} from "../lib/ghostStore";
import { deliverOrder } from "../lib/ghostBot";

const router: IRouter = Router();

function ownerSession(req: Request): boolean {
  return verifyOwnerSession(req.cookies?.ghost_owner_session);
}

function requireOwner(req: Request, res: Response): boolean {
  if (ownerSession(req)) return true;
  res.status(401).json({ error: "Owner setup is required" });
  return false;
}

function orderView(order: Order) {
  return {
    id: order.id,
    customerName: decrypt(order.customerNameEncrypted) || "Telegram user",
    username: decrypt(order.usernameEncrypted) || null,
    telegramId: decrypt(order.telegramIdEncrypted),
    productName: decrypt(order.productNameEncrypted),
    amount: order.amount,
    currency: order.currency,
    status: order.status,
    deliveryType: order.deliveryType,
    createdAt: order.createdAt,
    deliveredAt: order.deliveredAt,
    canRedeliver: order.status === "approved" && order.deliveryCount > 0,
  };
}

router.get("/shop/setup/status", async (req, res): Promise<void> => {
  const settings = await ensureShopInitialized();
  const result = GetSetupStatusResponse.parse({
    claimed: Boolean(settings.ownerTelegramIdEncrypted),
    sessionActive: ownerSession(req),
    message: settings.ownerTelegramIdEncrypted
      ? (ownerSession(req) ? "Owner panel unlocked" : "Enter the one-time setup code in Telegram")
      : "Add BOT_TOKEN, then enter the one-time setup code in Telegram",
  });
  res.json(result);
});

router.post("/shop/setup/claim", async (req, res): Promise<void> => {
  const parsed = ClaimOwnerSetupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const settings = await ensureShopInitialized();
  if (settings.ownerTelegramIdEncrypted) {
    res.status(409).json({ error: "Owner is already linked in Telegram" });
    return;
  }
  if (!settings.setupCodeHash || settings.setupCodeHash !== hashSetupCode(parsed.data.code.trim().toUpperCase())) {
    res.status(400).json({ error: "Invalid or expired setup code" });
    return;
  }
  await db.update(shopSettingsTable).set({ claimedAt: new Date(), updatedAt: new Date() }).where(eq(shopSettingsTable.id, settings.id));
  const token = signOwnerSession();
  res.cookie("ghost_owner_session", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 1000 * 60 * 60 * 24 * 30 });
  const next = await ensureShopInitialized();
  res.json(ClaimOwnerSetupResponse.parse({
    claimed: true,
    sessionActive: true,
    message: "Owner session unlocked",
  }));
  void logShopEvent("owner_panel_unlocked", "Owner panel unlocked");
  void next;
});

router.get("/shop/dashboard", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  await ensureShopInitialized();
  const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(8);
  const [summary] = await db.select({
    revenue: sql<number>`coalesce(sum(case when ${ordersTable.status} = 'approved' then ${ordersTable.amount} else 0 end), 0)`,
    totalOrders: sql<number>`count(*)`,
    pendingOrders: sql<number>`coalesce(sum(case when ${ordersTable.status} = 'pending' then 1 else 0 end), 0)`,
    productsSold: sql<number>`coalesce(sum(${ordersTable.deliveryCount}), 0)`,
  }).from(ordersTable);
  const [active] = await db.select({ count: sql<number>`count(*)` }).from(productsTable).where(eq(productsTable.active, true));
  const response = GetShopDashboardResponse.parse({
    revenue: Number(summary?.revenue ?? 0),
    revenueDelta: 0,
    pendingOrders: Number(summary?.pendingOrders ?? 0),
    totalOrders: Number(summary?.totalOrders ?? 0),
    productsSold: Number(summary?.productsSold ?? 0),
    activeProducts: Number(active?.count ?? 0),
    recentOrders: orders.map(orderView),
    salesByDay: [],
  });
  res.json(response);
});

router.get("/shop/orders", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const query = ListShopOrdersQueryParams.parse(req.query);
  const rows = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(query.limit ?? 50);
  const filtered = rows.filter((order) => {
    if (query.status && query.status !== "all" && order.status !== query.status) return false;
    if (!query.search) return true;
    const haystack = `${decrypt(order.customerNameEncrypted)} ${decrypt(order.usernameEncrypted)} ${decrypt(order.telegramIdEncrypted)} ${decrypt(order.productNameEncrypted)}`.toLowerCase();
    return haystack.includes(query.search.toLowerCase());
  });
  res.json(filtered.map(orderView));
});

async function decideOrder(id: number, decision: "approved" | "rejected", note?: string) {
  const existing = await getOrder(id);
  if (!existing) return { kind: "missing" as const };
  if (existing.status === decision) return { kind: "same" as const, order: existing };
  if (existing.status !== "pending") return { kind: "conflict" as const, order: existing };
  const [updated] = await db.update(ordersTable).set({
    status: decision,
    decisionNoteEncrypted: note ? encrypt(note) : null,
    updatedAt: new Date(),
  }).where(and(eq(ordersTable.id, id), eq(ordersTable.status, "pending"))).returning();
  return updated ? { kind: "updated" as const, order: updated } : { kind: "conflict" as const, order: await getOrder(id) };
}

router.post("/shop/orders/:id/approve", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const params = ApproveShopOrderParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const result = await decideOrder(params.data.id, "approved");
  if (result.kind === "missing") { res.status(404).json({ error: "Order not found" }); return; }
  if (result.kind === "conflict") { res.status(409).json({ error: "Order is already decided" }); return; }
  if (result.kind === "updated") void deliverOrder(params.data.id, false);
  if (result.kind === "updated") void logShopEvent("payment_approved", `Order #${params.data.id} approved`);
  res.json(orderView(result.order));
});

router.post("/shop/orders/:id/reject", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const params = RejectShopOrderParams.safeParse(req.params);
  const body = RejectShopOrderBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid order decision" }); return; }
  const result = await decideOrder(params.data.id, "rejected", body.data.note);
  if (result.kind === "missing") { res.status(404).json({ error: "Order not found" }); return; }
  if (result.kind === "conflict") { res.status(409).json({ error: "Order is already decided" }); return; }
  if (result.kind === "updated") void logShopEvent("payment_rejected", `Order #${params.data.id} rejected`);
  res.json(orderView(result.order));
});

router.post("/shop/orders/:id/redeliver", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const params = RedeliverShopOrderParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const order = await getOrder(params.data.id);
  if (!order || order.status !== "approved") { res.status(409).json({ error: "Only approved orders can be redelivered" }); return; }
  void deliverOrder(params.data.id, true);
  void logShopEvent("product_redelivered", `Order #${params.data.id} redelivery requested`);
  res.json(orderView(order));
});

router.get("/shop/products", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const rows = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));
  res.json(ListShopProductsResponse.parse(rows.map(toProductView)));
});

router.post("/shop/products", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const parsed = CreateShopProductBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [product] = await db.insert(productsTable).values({
    ...parsed.data,
    deliveryPayloadEncrypted: encrypt(`Позиция «${parsed.data.name}» ожидает загрузки цифрового содержимого через Telegram.`),
  }).returning();
  void logShopEvent("product_created", `Product #${product!.id} created`);
  res.status(201).json(toProductView(product!));
});

router.patch("/shop/products/:id", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const params = UpdateShopProductParams.safeParse(req.params);
  const body = UpdateShopProductBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Invalid product update" }); return; }
  const [product] = await db.update(productsTable).set({ ...body.data, updatedAt: new Date() }).where(eq(productsTable.id, params.data.id)).returning();
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  void logShopEvent("product_updated", `Product #${product.id} updated`);
  res.json(toProductView(product));
});

router.delete("/shop/products/:id", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const params = DeleteShopProductParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [product] = await db.update(productsTable).set({ active: false, updatedAt: new Date() }).where(eq(productsTable.id, params.data.id)).returning();
  if (!product) { res.status(404).json({ error: "Product not found" }); return; }
  void logShopEvent("product_archived", `Product #${product.id} archived`);
  res.status(204).send();
});

router.get("/shop/settings", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const settings = await getSettings();
  res.json(GetShopSettingsResponse.parse({
    shopName: settings.shopName,
    paymentInstructions: decrypt(settings.paymentInstructions) || settings.paymentInstructions,
    supportHandle: decrypt(settings.supportHandle) || settings.supportHandle,
    botStatus: settings.botStatus,
  }));
});

router.patch("/shop/settings", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const parsed = UpdateShopSettingsBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const settings = await getSettings();
  const [updated] = await db.update(shopSettingsTable).set({
    shopName: parsed.data.shopName,
    paymentInstructions: encrypt(parsed.data.paymentInstructions),
    supportHandle: encrypt(parsed.data.supportHandle),
    botStatus: parsed.data.botStatus,
    updatedAt: new Date(),
  }).where(eq(shopSettingsTable.id, settings.id)).returning();
  void logShopEvent("settings_updated", "Payment instructions updated");
  res.json(GetShopSettingsResponse.parse({
    shopName: updated!.shopName,
    paymentInstructions: parsed.data.paymentInstructions,
    supportHandle: parsed.data.supportHandle,
    botStatus: updated!.botStatus,
  }));
});

router.get("/shop/events", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const query = ListShopEventsQueryParams.parse(req.query);
  const rows = await db.select().from(eventsTable).orderBy(desc(eventsTable.createdAt)).limit(query.limit ?? 30);
  res.json(rows);
});

router.get("/shop/support", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const tickets = await getSupportTickets();
  res.json(ListShopSupportResponse.parse(tickets.map((ticket) => ({
    id: ticket.id,
    customerName: decrypt(ticket.customerNameEncrypted) || "Telegram user",
    username: decrypt(ticket.usernameEncrypted) || null,
    topic: ticket.topic,
    status: ticket.status,
    lastMessage: decrypt(ticket.lastMessageEncrypted),
    updatedAt: ticket.updatedAt,
  }))));
});

export default router;