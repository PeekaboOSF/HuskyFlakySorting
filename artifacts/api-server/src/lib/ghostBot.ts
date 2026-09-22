import { and, desc, eq } from "drizzle-orm";
import {
  db,
  ordersTable,
  productsTable,
  shopSettingsTable,
  supportTicketsTable,
} from "@workspace/db";
import { decrypt, encrypt, lookupHash } from "./ghostSecurity";
import { ensureShopInitialized, getOrder, getProduct, getSettings, logShopEvent } from "./ghostStore";
import { logger } from "./logger";

type TelegramMessage = {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  from?: { id: number; first_name?: string; last_name?: string; username?: string };
  document?: { file_id: string; file_name?: string };
  photo?: { file_id: string }[];
  video?: { file_id: string };
  audio?: { file_id: string };
  voice?: { file_id: string };
  animation?: { file_id: string };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; data?: string; from: { id: number }; message?: TelegramMessage };
};

type WizardState = { stage: "meta" | "payload" | "replacePayload"; productId?: number; name?: string; price?: number; currency?: string };
const wizard = new Map<string, WizardState>();
const deliveryLocks = new Set<number>();
let offset = 0;
let botUsername = "";

function token(): string | undefined {
  return process.env.BOT_TOKEN?.trim() || undefined;
}

async function telegram<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
  const botToken = token();
  if (!botToken) return null;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { ok: boolean; result?: T };
  if (!result.ok) {
    logger.warn({ method }, "Telegram API request failed");
    return null;
  }
  return result.result ?? null;
}

async function sendMessage(chatId: number, text: string, replyMarkup?: Record<string, unknown>): Promise<void> {
  await telegram("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(id: string, text?: string): Promise<void> {
  await telegram("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "Каталог", callback_data: "catalog" }, { text: "Мои заказы", callback_data: "my_orders" }],
      [{ text: "Поддержка", callback_data: "support" }],
    ],
  };
}

function deliveryFromMessage(message: TelegramMessage): { type: string; label: string; payload: string } | null {
  if (message.document) return { type: "document", label: message.document.file_name ?? "Документ", payload: message.document.file_id };
  if (message.photo?.length) return { type: "photo", label: "Фото", payload: message.photo[message.photo.length - 1]!.file_id };
  if (message.video) return { type: "video", label: "Видео", payload: message.video.file_id };
  if (message.audio) return { type: "audio", label: "Аудио", payload: message.audio.file_id };
  if (message.voice) return { type: "voice", label: "Voice", payload: message.voice.file_id };
  if (message.animation) return { type: "gif", label: "GIF", payload: message.animation.file_id };
  if (message.text && !message.text.startsWith("/")) return { type: "text", label: "Текст", payload: message.text };
  return null;
}

async function sendDelivery(chatId: number, product: typeof productsTable.$inferSelect): Promise<boolean> {
  const payload = decrypt(product.deliveryPayloadEncrypted);
  if (!payload) return false;
  if (product.deliveryType === "document") await telegram("sendDocument", { chat_id: chatId, document: payload });
  else if (product.deliveryType === "photo") await telegram("sendPhoto", { chat_id: chatId, photo: payload });
  else if (product.deliveryType === "video") await telegram("sendVideo", { chat_id: chatId, video: payload });
  else if (product.deliveryType === "audio") await telegram("sendAudio", { chat_id: chatId, audio: payload });
  else if (product.deliveryType === "voice") await telegram("sendVoice", { chat_id: chatId, voice: payload });
  else if (product.deliveryType === "gif") await telegram("sendAnimation", { chat_id: chatId, animation: payload });
  else await sendMessage(chatId, `Ваш товар готов:\n\n${payload}`);
  return true;
}

export async function deliverOrder(orderId: number, force: boolean): Promise<boolean> {
  if (deliveryLocks.has(orderId)) return false;
  deliveryLocks.add(orderId);
  try {
    const order = await getOrder(orderId);
    if (!order || order.status !== "approved" || (!force && order.deliveryCount > 0)) return false;
    const product = await getProduct(order.productId);
    if (!product) return false;
    const chatId = Number(decrypt(order.telegramIdEncrypted));
    if (!Number.isFinite(chatId)) return false;
    const sent = await sendDelivery(chatId, product);
    if (!sent) return false;
    await db.update(ordersTable).set({
      deliveryCount: order.deliveryCount + 1,
      deliveredAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(ordersTable.id, orderId),
      eq(ordersTable.status, "approved"),
      ...(force ? [] : [eq(ordersTable.deliveryCount, 0)]),
    ));
    void logShopEvent(force ? "product_redelivered" : "product_delivered", `Order #${orderId} delivery completed`);
    return true;
  } finally {
    deliveryLocks.delete(orderId);
  }
}

async function ownerId(): Promise<number | null> {
  const settings = await ensureShopInitialized();
  if (!settings.ownerTelegramIdEncrypted) return null;
  const value = Number(decrypt(settings.ownerTelegramIdEncrypted));
  return Number.isFinite(value) ? value : null;
}

async function sendCatalog(chatId: number): Promise<void> {
  const products = await db.select().from(productsTable).where(eq(productsTable.active, true)).orderBy(desc(productsTable.createdAt));
  if (!products.length) {
    await sendMessage(chatId, "Сейчас каталог пуст. Возвращайтесь позже.", mainMenu());
    return;
  }
  await sendMessage(chatId, "<b>GHOST DIGITAL</b>\n\nВыберите позицию:", {
    inline_keyboard: products.map((product) => [{
      text: `${product.name} · ${product.price} ${product.currency}`,
      callback_data: `product:${product.id}`,
    }]),
  });
}

async function showProduct(chatId: number, id: number): Promise<void> {
  const product = await getProduct(id);
  if (!product || !product.active) {
    await sendMessage(chatId, "Эта позиция больше недоступна.", mainMenu());
    return;
  }
  await sendMessage(chatId, `<b>${product.name}</b>\n\n${product.description}\n\n<b>${product.price} ${product.currency}</b>\nФормат выдачи: ${product.deliveryLabel}`, {
    inline_keyboard: [
      [{ text: "Оформить заказ", callback_data: `buy:${product.id}` }],
      [{ text: "Назад к каталогу", callback_data: "catalog" }],
    ],
  });
}

async function createOrder(chatId: number, message: TelegramMessage, productId: number): Promise<void> {
  const product = await getProduct(productId);
  if (!product || !product.active) {
    await sendMessage(chatId, "Позиция недоступна.", mainMenu());
    return;
  }
  const existing = await db.select().from(ordersTable).where(and(
    eq(ordersTable.telegramLookupHash, lookupHash(String(chatId))),
    eq(ordersTable.productId, productId),
    eq(ordersTable.status, "pending"),
  )).orderBy(desc(ordersTable.createdAt)).limit(1);
  if (existing.length) {
    await sendMessage(chatId, "У вас уже есть ожидающий заказ на эту позицию. Нажмите кнопку ниже после оплаты.", {
      inline_keyboard: [[{ text: "Я оплатил", callback_data: `paid:${existing[0]!.id}` }]],
    });
    return;
  }
  const [order] = await db.insert(ordersTable).values({
    customerNameEncrypted: encrypt([message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Telegram user"),
    usernameEncrypted: message.from?.username ? encrypt(`@${message.from.username}`) : null,
    telegramIdEncrypted: encrypt(String(chatId)),
    telegramLookupHash: lookupHash(String(chatId)),
    productId,
    productNameEncrypted: encrypt(product.name),
    amount: product.price,
    currency: product.currency,
    status: "pending",
    deliveryType: product.deliveryType,
  }).returning();
  if (!order) return;
  const settings = await getSettings();
  const paymentInstructions = decrypt(settings.paymentInstructions) || settings.paymentInstructions;
  await sendMessage(chatId, `<b>Заказ #${order.id}</b>\n\n${product.name}\nСумма: <b>${product.price} ${product.currency}</b>\n\n<b>Инструкция по оплате</b>\n${paymentInstructions}\n\nПосле перевода нажмите кнопку один раз.`, {
    inline_keyboard: [[{ text: "Я оплатил", callback_data: `paid:${order.id}` }], [{ text: "Мои заказы", callback_data: "my_orders" }]],
  });
  void logShopEvent("order_created", `Order #${order.id} created`);
}

async function notifyOwner(orderId: number): Promise<void> {
  const chatId = await ownerId();
  const order = await getOrder(orderId);
  if (!chatId || !order) return;
  await sendMessage(chatId, `<b>Новый заказ #${order.id}</b>\n\nПокупатель: ${decrypt(order.customerNameEncrypted)}\nUsername: ${decrypt(order.usernameEncrypted) || "—"}\nTelegram ID: ${decrypt(order.telegramIdEncrypted)}\nТовар: ${decrypt(order.productNameEncrypted)}\nСумма: <b>${order.amount} ${order.currency}</b>\nСтатус: ожидает проверки`, {
    inline_keyboard: [[
      { text: "Подтвердить", callback_data: `approve:${order.id}` },
      { text: "Отклонить", callback_data: `reject:${order.id}` },
    ]],
  });
}

async function handleOwnerCommand(chatId: number, text: string, message: TelegramMessage): Promise<boolean> {
  const owner = await ownerId();
  if (text.startsWith("/setup ")) {
    const settings = await ensureShopInitialized();
    if (settings.ownerTelegramIdEncrypted) {
      await sendMessage(chatId, "Владелец уже привязан. Эта команда больше недоступна.");
      return true;
    }
    const code = text.slice(7).trim().toUpperCase();
    if (!settings.setupCodeHash || settings.setupCodeHash !== lookupHash(code)) {
      await sendMessage(chatId, "Код не принят. Проверьте точность и срок действия.");
      return true;
    }
    await db.update(shopSettingsTable).set({
      ownerTelegramIdEncrypted: encrypt(String(chatId)),
      setupCodeHash: null,
      setupCodeIssuedAt: null,
      claimedAt: new Date(),
      botStatus: "online",
      updatedAt: new Date(),
    }).where(eq(shopSettingsTable.id, settings.id));
    await sendMessage(chatId, "<b>Владелец привязан.</b>\nСкрытая панель доступна только этому Telegram-аккаунту.", {
      inline_keyboard: [[{ text: "Открыть панель", callback_data: "admin:home" }]],
    });
    void logShopEvent("owner_linked", "Owner linked via one-time setup code");
    return true;
  }
  if (chatId !== owner) return false;
  if (text === "/owner" || text === "/admin") {
    await sendMessage(chatId, "<b>GHOST OWNER</b>\n\nПанель управления магазином.", {
      inline_keyboard: [
        [{ text: "Статистика", callback_data: "admin:stats" }, { text: "Заказы", callback_data: "admin:orders" }],
        [{ text: "Товары", callback_data: "admin:products" }, { text: "Поддержка", callback_data: "admin:support" }],
        [{ text: "Оплата", callback_data: "admin:payment" }],
      ],
    });
    return true;
  }
  if (text === "/newproduct") {
    wizard.set(String(chatId), { stage: "meta" });
    await sendMessage(chatId, "Создание товара.\nОтправьте одной строкой:\n<b>Название | Цена | Валюта</b>");
    return true;
  }
  if (text.startsWith("/setcontent ")) {
    const productId = Number(text.slice(12).trim());
    if (!Number.isInteger(productId) || !(await getProduct(productId))) {
      await sendMessage(chatId, "Укажите существующий ID позиции. Например: <b>/setcontent 3</b>");
      return true;
    }
    wizard.set(String(chatId), { stage: "replacePayload", productId });
    await sendMessage(chatId, "Отправьте новое содержимое позиции: текст, документ, фото, видео, аудио, voice или GIF.");
    return true;
  }
  const state = wizard.get(String(chatId));
  if (state?.stage === "meta") {
    const [name, priceRaw, currencyRaw] = text.split("|").map((part) => part.trim());
    const price = Number(priceRaw);
    if (!name || !Number.isFinite(price) || price < 0) {
      await sendMessage(chatId, "Не понял формат. Пример: <b>Private pack | 990 | RUB</b>");
      return true;
    }
    wizard.set(String(chatId), { stage: "payload", name, price, currency: currencyRaw || "RUB" });
    await sendMessage(chatId, "Теперь отправьте содержимое товара: текст, документ, фото, видео, аудио, voice или GIF.");
    return true;
  }
  if (state?.stage === "payload") {
    const delivery = deliveryFromMessage(message);
    if (!delivery || !state.name || state.price === undefined) {
      await sendMessage(chatId, "Нужен текст или поддерживаемый файл: документ, фото, видео, аудио, voice или GIF.");
      return true;
    }
    const [product] = await db.insert(productsTable).values({
      name: state.name,
      description: "Добавлено владельцем через Telegram.",
      price: state.price,
      currency: state.currency || "RUB",
      deliveryType: delivery.type,
      deliveryLabel: delivery.label,
      deliveryPayloadEncrypted: encrypt(delivery.payload),
      inventory: 999,
      active: true,
    }).returning();
    wizard.delete(String(chatId));
    await sendMessage(chatId, `Позиция <b>${product?.name ?? state.name}</b> добавлена в каталог.`);
    void logShopEvent("product_created", `Product added via Telegram`);
    return true;
  }
  if (state?.stage === "replacePayload" && state.productId) {
    const delivery = deliveryFromMessage(message);
    if (!delivery) {
      await sendMessage(chatId, "Нужен текст или поддерживаемый файл.");
      return true;
    }
    await db.update(productsTable).set({
      deliveryType: delivery.type,
      deliveryLabel: delivery.label,
      deliveryPayloadEncrypted: encrypt(delivery.payload),
      updatedAt: new Date(),
    }).where(eq(productsTable.id, state.productId));
    wizard.delete(String(chatId));
    await sendMessage(chatId, `Содержимое позиции #${state.productId} обновлено.`);
    void logShopEvent("product_content_updated", `Product #${state.productId} content updated`);
    return true;
  }
  return false;
}

async function handleCallback(query: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  const chatId = query.message?.chat.id ?? query.from.id;
  const data = query.data ?? "";
  await answerCallback(query.id);
  if (data === "catalog") return sendCatalog(chatId);
  if (data.startsWith("product:")) return showProduct(chatId, Number(data.slice(8)));
  if (data.startsWith("buy:")) return createOrder(chatId, query.message ?? { message_id: 0, chat: { id: chatId }, from: { id: chatId } }, Number(data.slice(4)));
  if (data === "my_orders") {
    const orders = await db.select().from(ordersTable).where(eq(ordersTable.telegramLookupHash, lookupHash(String(chatId)))).orderBy(desc(ordersTable.createdAt)).limit(10);
    await sendMessage(chatId, orders.length ? orders.map((order) => `#${order.id} · ${decrypt(order.productNameEncrypted)} · ${order.status === "approved" ? "выдан" : order.status === "rejected" ? "отклонён" : "ожидает проверки"}`).join("\n") : "Заказов пока нет.", mainMenu());
    return;
  }
  if (data === "support") {
    await sendMessage(chatId, "Напишите сообщение следующим текстом. Владелец увидит его в очереди поддержки.");
    return;
  }
  if (data.startsWith("paid:")) {
    const id = Number(data.slice(5));
    const order = await getOrder(id);
    if (!order || decrypt(order.telegramIdEncrypted) !== String(chatId)) return;
    if (order.status !== "pending") {
      await sendMessage(chatId, "Этот заказ уже обработан. Повторное нажатие ничего не изменит.", mainMenu());
      return;
    }
    await sendMessage(chatId, "Отметка получена. Владелец проверит оплату и пришлёт товар после подтверждения.");
    await notifyOwner(id);
    return;
  }
  const owner = await ownerId();
  if (chatId !== owner) return;
  if (data === "admin:home") {
    await handleOwnerCommand(chatId, "/owner", { message_id: 0, chat: { id: chatId }, from: { id: chatId }, text: "/owner" });
    return;
  }
  if (data === "admin:stats") {
    const all = await db.select().from(ordersTable);
    const revenue = all.filter((order) => order.status === "approved").reduce((sum, order) => sum + order.amount, 0);
    await sendMessage(chatId, `<b>Статистика</b>\n\nВыручка: <b>${revenue.toFixed(2)} RUB</b>\nЗаказов: ${all.length}\nОжидают проверки: ${all.filter((order) => order.status === "pending").length}\nВыдано: ${all.reduce((sum, order) => sum + order.deliveryCount, 0)}`);
    return;
  }
  if (data === "admin:orders") {
    const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(10);
    await sendMessage(chatId, orders.length ? orders.map((order) => `#${order.id} · ${decrypt(order.productNameEncrypted)} · ${order.amount} ${order.currency} · ${order.status}`).join("\n") : "Заказов пока нет.");
    return;
  }
  if (data === "admin:products") {
    const products = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));
    await sendMessage(chatId, `${products.map((product) => `#${product.id} · ${product.name} · ${product.price} ${product.currency} · ${product.active ? "активен" : "архив"}`).join("\n") || "Позиций пока нет"}\n\nДля добавления отправьте /newproduct`);
    return;
  }
  if (data === "admin:payment") {
    const settings = await getSettings();
    await sendMessage(chatId, `<b>Инструкции по оплате</b>\n\n${decrypt(settings.paymentInstructions) || settings.paymentInstructions}\n\nИзменение текста: /setpayment новый текст`);
    return;
  }
  if (data === "admin:support") {
    const tickets = await db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.updatedAt)).limit(10);
    await sendMessage(chatId, tickets.length ? tickets.map((ticket) => `#${ticket.id} · ${ticket.topic} · ${ticket.status}\n${decrypt(ticket.lastMessageEncrypted)}`).join("\n\n") : "Очередь поддержки пуста.");
    return;
  }
  if (data.startsWith("approve:") || data.startsWith("reject:")) {
    const id = Number(data.split(":")[1]);
    const decision = data.startsWith("approve:") ? "approved" : "rejected";
    const order = await getOrder(id);
    if (!order) return;
    if (order.status === "pending") {
      await db.update(ordersTable).set({ status: decision, updatedAt: new Date() }).where(and(eq(ordersTable.id, id), eq(ordersTable.status, "pending")));
      if (decision === "approved") await deliverOrder(id, false);
      else await sendMessage(Number(decrypt(order.telegramIdEncrypted)), "Оплата отклонена. Если это ошибка, напишите в поддержку.");
    }
    await sendMessage(chatId, `Заказ #${id}: ${decision === "approved" ? "подтверждён, выдача выполнена" : "отклонён"}.`);
    return;
  }
  if (data.startsWith("redeliver:")) {
    await deliverOrder(Number(data.slice(10)), true);
  }
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const text = message.text?.trim() ?? "";
  if (text.startsWith("/")) {
    const handled = await handleOwnerCommand(chatId, text, message);
    if (handled) return;
    if (text === "/start" || text === "/catalog") {
      await sendMessage(chatId, "<b>GHOST DIGITAL</b>\n\nЦифровые товары с выдачей после ручной проверки оплаты.", mainMenu());
      await sendCatalog(chatId);
      return;
    }
    if (text === "/owner") {
      await sendMessage(chatId, "Панель доступна только владельцу.");
      return;
    }
  }
  const owner = await ownerId();
  if (owner === chatId && text.startsWith("/setpayment ")) {
    const instructions = text.slice(12).trim();
    await db.update(shopSettingsTable).set({ paymentInstructions: encrypt(instructions), updatedAt: new Date() }).where(eq(shopSettingsTable.id, (await getSettings()).id));
    await sendMessage(chatId, "Инструкции по оплате обновлены.");
    void logShopEvent("settings_updated", "Payment instructions updated via Telegram");
    return;
  }
  if (owner !== chatId && text && !text.startsWith("/")) {
    await db.insert(supportTicketsTable).values({
      customerNameEncrypted: encrypt(message.from?.first_name ?? "Telegram user"),
      usernameEncrypted: message.from?.username ? encrypt(`@${message.from.username}`) : null,
      telegramLookupHash: lookupHash(String(chatId)),
      topic: "Сообщение покупателя",
      status: "open",
      lastMessageEncrypted: encrypt(text),
    });
    await sendMessage(chatId, "Сообщение передано в поддержку.", mainMenu());
  }
}

async function poll(): Promise<void> {
  try {
    const updates = await telegram<TelegramUpdate[]>("getUpdates", { offset, timeout: 20, allowed_updates: ["message", "callback_query"] });
    for (const update of updates ?? []) {
      offset = update.update_id + 1;
      if (update.callback_query) await handleCallback(update.callback_query);
      else if (update.message) await handleMessage(update.message);
    }
  } catch (error) {
    logger.warn({ err: error }, "Ghost Telegram polling error");
  }
  setTimeout(() => void poll(), 1000);
}

export function startGhostBot(): void {
  if (!token()) {
    logger.warn("BOT_TOKEN is not configured. Ghost runs in safe mode; add BOT_TOKEN to start the Telegram bot.");
    return;
  }
  void (async () => {
    await ensureShopInitialized();
    const me = await telegram<{ username?: string }>("getMe", {});
    if (!me) {
      const settings = await getSettings();
      await db.update(shopSettingsTable).set({ botStatus: "paused", updatedAt: new Date() }).where(eq(shopSettingsTable.id, settings.id));
      logger.error("BOT_TOKEN is present but Telegram rejected it. Replace BOT_TOKEN in Secrets with a valid BotFather token.");
      return;
    }
    botUsername = me?.username ?? "";
    const settings = await getSettings();
    await db.update(shopSettingsTable).set({ botStatus: "online", updatedAt: new Date() }).where(eq(shopSettingsTable.id, settings.id));
    logger.info({ botUsername }, "Ghost Telegram bot started");
    await poll();
  })();
}