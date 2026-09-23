import { and, desc, eq } from "drizzle-orm";
import {
  db,
  ordersTable,
  paymentCardsTable,
  productsTable,
  shopSettingsTable,
  supportTicketsTable,
} from "@workspace/db";
import { decrypt, encrypt, lookupHash } from "./ghostSecurity";
import {
  claimNextPaymentCard,
  ensureShopInitialized,
  getOrder,
  getProduct,
  getSettings,
  isShopCity,
  SHOP_CITIES,
  logShopEvent,
} from "./ghostStore";
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

type WizardState = {
  stage: "meta" | "payload" | "replacePayload" | "cardPayload" | "supportReply" | "paymentInstructions";
  productId?: number;
  name?: string;
  price?: number;
  currency?: string;
  ticketId?: number;
};
const wizard = new Map<string, WizardState>();
const cityByChat = new Map<string, string>();
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
      [{ text: "Выбрать город", callback_data: "cities" }],
      [{ text: "Каталог", callback_data: "catalog" }, { text: "Мои заказы", callback_data: "my_orders" }],
      [{ text: "Поддержка", callback_data: "support" }],
    ],
  };
}

function cityMenu() {
  return {
    inline_keyboard: SHOP_CITIES.map((city, index) => [{ text: city, callback_data: `city:${index}` }]),
  };
}

function cityForChat(chatId: number): string | undefined {
  const city = cityByChat.get(String(chatId));
  return city && isShopCity(city) ? city : undefined;
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
  const city = cityForChat(chatId);
  if (!city) {
    await sendMessage(chatId, "Сначала выберите город получения:", cityMenu());
    return;
  }
  const products = await db.select().from(productsTable).where(eq(productsTable.active, true)).orderBy(desc(productsTable.createdAt));
  if (!products.length) {
    await sendMessage(chatId, "Сейчас каталог пуст. Возвращайтесь позже.", mainMenu());
    return;
  }
  await sendMessage(chatId, `<b>HASKIBOTRAIN</b>\n\nГород: <b>${city}</b>\nВыберите позицию:`, {
    inline_keyboard: products.map((product) => [{
      text: `${product.name} · ${product.price} ${product.currency}`,
      callback_data: `product:${product.id}`,
    }]),
  });
}

async function showProduct(chatId: number, id: number): Promise<void> {
  const city = cityForChat(chatId);
  if (!city) {
    await sendMessage(chatId, "Сначала выберите город получения:", cityMenu());
    return;
  }
  const product = await getProduct(id);
  if (!product || !product.active) {
    await sendMessage(chatId, "Эта позиция больше недоступна.", mainMenu());
    return;
  }
  await sendMessage(chatId, `<b>${product.name}</b>\n\nГород: ${city}\n${product.description}\n\n<b>${product.price} ${product.currency}</b>\nФормат выдачи: ${product.deliveryLabel}`, {
    inline_keyboard: [
      [{ text: "Оформить заказ", callback_data: `buy:${product.id}` }],
      [{ text: "Назад к каталогу", callback_data: "catalog" }],
    ],
  });
}

async function createOrder(chatId: number, message: TelegramMessage, productId: number): Promise<void> {
  const city = cityForChat(chatId);
  if (!city) {
    await sendMessage(chatId, "Сначала выберите город получения:", cityMenu());
    return;
  }
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
    const previousPayment = decrypt(existing[0]!.paymentDetailsEncrypted);
    await sendMessage(chatId, `У вас уже есть ожидающий заказ на эту позицию в городе ${existing[0]!.city}.\n\n${previousPayment ? `<b>Данные для оплаты</b>\n${previousPayment}\n\n` : ""}Нажмите кнопку ниже после оплаты.`, {
      inline_keyboard: [[{ text: "Я оплатил", callback_data: `paid:${existing[0]!.id}` }]],
    });
    return;
  }
  const paymentCard = await claimNextPaymentCard();
  const settings = await getSettings();
  const baseInstructions = decrypt(settings.paymentInstructions) || settings.paymentInstructions;
  const paymentDetails = [
    paymentCard ? `<b>${paymentCard.label}</b>\n${decrypt(paymentCard.detailsEncrypted)}` : "",
    baseInstructions,
  ].filter(Boolean).join("\n\n");
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
    city,
    paymentDetailsEncrypted: paymentDetails ? encrypt(paymentDetails) : null,
  }).returning();
  if (!order) return;
  await sendMessage(chatId, `<b>Заказ #${order.id}</b>\n\n${product.name}\nГород: <b>${city}</b>\nСумма: <b>${product.price} ${product.currency}</b>\n\n<b>Инструкция по оплате</b>\n${paymentDetails || "Инструкции по оплате пока не настроены владельцем."}\n\nПосле перевода нажмите кнопку один раз.`, {
    inline_keyboard: [[{ text: "Я оплатил", callback_data: `paid:${order.id}` }], [{ text: "Мои заказы", callback_data: "my_orders" }]],
  });
  void logShopEvent("order_created", `Order #${order.id} created`);
}

async function notifyOwner(orderId: number): Promise<void> {
  const chatId = await ownerId();
  const order = await getOrder(orderId);
  if (!chatId || !order) return;
  await sendMessage(chatId, `<b>Новый заказ #${order.id}</b>\n\nПокупатель: ${decrypt(order.customerNameEncrypted)}\nUsername: ${decrypt(order.usernameEncrypted) || "—"}\nTelegram ID: ${decrypt(order.telegramIdEncrypted)}\nГород: <b>${order.city}</b>\nТовар: ${decrypt(order.productNameEncrypted)}\nСумма: <b>${order.amount} ${order.currency}</b>\nСтатус: ожидает проверки`, {
    inline_keyboard: [[
      { text: "Подтвердить", callback_data: `approve:${order.id}` },
      { text: "Отклонить", callback_data: `reject:${order.id}` },
    ]],
  });
}

function maskCardDetails(details: string): string {
  const digits = details.replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "данные сохранены";
}

async function sendSupportQueue(chatId: number): Promise<void> {
  const tickets = await db.select().from(supportTicketsTable).orderBy(desc(supportTicketsTable.updatedAt)).limit(10);
  if (!tickets.length) {
    await sendMessage(chatId, "Очередь поддержки пуста.");
    return;
  }
  for (const ticket of tickets) {
    await sendMessage(chatId, `<b>Обращение #${ticket.id}</b>\n${decrypt(ticket.customerNameEncrypted)} · ${ticket.status}\n\n${decrypt(ticket.lastMessageEncrypted)}`, {
      inline_keyboard: [
        [{ text: "Ответить", callback_data: `support:reply:${ticket.id}` }, { text: "Закрыть", callback_data: `support:close:${ticket.id}` }],
      ],
    });
  }
}

async function notifyOwnerSupport(ticketId: number): Promise<void> {
  const chatId = await ownerId();
  if (!chatId) return;
  const [ticket] = await db.select().from(supportTicketsTable).where(eq(supportTicketsTable.id, ticketId)).limit(1);
  if (!ticket) return;
  await sendMessage(chatId, `<b>Новое обращение #${ticket.id}</b>\n\n${decrypt(ticket.customerNameEncrypted)}\n${decrypt(ticket.lastMessageEncrypted)}`, {
    inline_keyboard: [[{ text: "Ответить", callback_data: `support:reply:${ticket.id}` }, { text: "Закрыть", callback_data: `support:close:${ticket.id}` }]],
  });
}

async function replyToTicket(ownerChatId: number, ticketId: number, reply: string): Promise<void> {
  const [ticket] = await db.select().from(supportTicketsTable).where(eq(supportTicketsTable.id, ticketId)).limit(1);
  if (!ticket || !ticket.telegramIdEncrypted) {
    await sendMessage(ownerChatId, "Обращение не найдено или создано до обновления поддержки.");
    return;
  }
  const customerChatId = Number(decrypt(ticket.telegramIdEncrypted));
  if (!Number.isFinite(customerChatId)) {
    await sendMessage(ownerChatId, "У обращения нет доступного Telegram-чата.");
    return;
  }
  await sendMessage(customerChatId, `<b>Ответ поддержки</b>\n\n${reply}`, mainMenu());
  await db.update(supportTicketsTable).set({
    status: "answered",
    lastMessageEncrypted: encrypt(reply),
    updatedAt: new Date(),
  }).where(eq(supportTicketsTable.id, ticketId));
  await sendMessage(ownerChatId, `Ответ по обращению #${ticketId} отправлен.`);
  void logShopEvent("support_replied", `Support ticket #${ticketId} answered`);
}

async function updatePaymentInstructions(ownerChatId: number, instructions: string): Promise<void> {
  const settings = await getSettings();
  await db.update(shopSettingsTable).set({
    paymentInstructions: encrypt(instructions),
    updatedAt: new Date(),
  }).where(eq(shopSettingsTable.id, settings.id));
  await sendMessage(ownerChatId, "Инструкции по оплате обновлены.");
  void logShopEvent("settings_updated", "Payment instructions updated via Telegram");
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
  if (text === "/setpayment" || text.startsWith("/setpayment ")) {
    const instructions = text.slice("/setpayment".length).trim();
    if (instructions) {
      wizard.delete(String(chatId));
      await updatePaymentInstructions(chatId, instructions);
    } else {
      wizard.set(String(chatId), { stage: "paymentInstructions" });
      await sendMessage(chatId, "Отправьте следующим сообщением новый текст инструкции по оплате.\n\nДля отмены отправьте /owner.");
    }
    return true;
  }
  if (text === "/owner" || text === "/admin") {
    await sendMessage(chatId, "<b>GHOST OWNER</b>\n\nПанель управления магазином.", {
      inline_keyboard: [
        [{ text: "Статистика", callback_data: "admin:stats" }, { text: "Заказы", callback_data: "admin:orders" }],
        [{ text: "Товары", callback_data: "admin:products" }, { text: "Поддержка", callback_data: "admin:support" }],
        [{ text: "Оплата", callback_data: "admin:payment" }, { text: "Карты", callback_data: "admin:cards" }],
      ],
    });
    return true;
  }
  if (text === "/addcard") {
    wizard.set(String(chatId), { stage: "cardPayload" });
    await sendMessage(chatId, "Добавление карты.\nОтправьте одной строкой:\n<b>Название карты | реквизиты и комментарий для покупателя</b>\n\nНапример: Сбербанк | 2200 0000 0000 0000, имя получателя");
    return true;
  }
  if (text === "/cards") {
    const cards = await db.select().from(paymentCardsTable).orderBy(desc(paymentCardsTable.createdAt));
    await sendMessage(chatId, cards.length
      ? cards.map((card) => `#${card.id} · ${card.label} · ${card.active ? "активна" : "выключена"} · использована ${card.usageCount} раз · ${maskCardDetails(decrypt(card.detailsEncrypted))}`).join("\n")
      : "Карт пока нет.\nДля добавления отправьте /addcard");
    return true;
  }
  if (text.startsWith("/disablecard ") || text.startsWith("/enablecard ")) {
    const disabling = text.startsWith("/disablecard ");
    const id = Number(text.split(/\s+/)[1]);
    if (!Number.isInteger(id)) {
      await sendMessage(chatId, `Укажите ID карты. Например: <b>/${disabling ? "disablecard" : "enablecard"} 1</b>`);
      return true;
    }
    const [card] = await db.update(paymentCardsTable).set({ active: !disabling, updatedAt: new Date() }).where(eq(paymentCardsTable.id, id)).returning();
    await sendMessage(chatId, card
      ? `Карта #${id} ${disabling ? "выключена" : "включена"}.`
      : "Карта не найдена.");
    return true;
  }
  if (text.startsWith("/reply ")) {
    const [, idRaw, ...replyParts] = text.split(/\s+/);
    const ticketId = Number(idRaw);
    const reply = replyParts.join(" ").trim();
    if (!Number.isInteger(ticketId) || !reply) {
      await sendMessage(chatId, "Формат: <b>/reply ID текст ответа</b>");
      return true;
    }
    await replyToTicket(chatId, ticketId, reply);
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
  if (state?.stage === "cardPayload") {
    const payload = text.trim();
    const separator = payload.indexOf("|");
    const label = (separator >= 0 ? payload.slice(0, separator) : "Платёжная карта").trim();
    const details = (separator >= 0 ? payload.slice(separator + 1) : payload).trim();
    if (!details) {
      await sendMessage(chatId, "Отправьте реквизиты карты. Они будут храниться зашифрованно.");
      return true;
    }
    const [card] = await db.insert(paymentCardsTable).values({
      label: label || "Платёжная карта",
      detailsEncrypted: encrypt(details),
      active: true,
    }).returning();
    wizard.delete(String(chatId));
    await sendMessage(chatId, `Карта #${card?.id ?? "?"} добавлена и включена в последовательную выдачу.`);
    void logShopEvent("payment_card_added", "Payment card added by owner");
    return true;
  }
  if (state?.stage === "supportReply" && state.ticketId) {
    if (!text) {
      await sendMessage(chatId, "Напишите текст ответа.");
      return true;
    }
    wizard.delete(String(chatId));
    await replyToTicket(chatId, state.ticketId, text);
    return true;
  }
  if (state?.stage === "paymentInstructions") {
    if (!text || text.startsWith("/")) {
      await sendMessage(chatId, "Нужен обычный текст инструкции по оплате. Для отмены отправьте /owner.");
      return true;
    }
    wizard.delete(String(chatId));
    await updatePaymentInstructions(chatId, text);
    return true;
  }
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
  if (data === "cities") {
    await sendMessage(chatId, "Выберите город получения:", cityMenu());
    return;
  }
  if (data.startsWith("city:")) {
    const index = Number(data.slice(5));
    const city = Number.isInteger(index) ? SHOP_CITIES[index] : undefined;
    if (!city) {
      await sendMessage(chatId, "Город не найден. Выберите его ещё раз.", cityMenu());
      return;
    }
    cityByChat.set(String(chatId), city);
    await sendMessage(chatId, `Город выбран: <b>${city}</b>`, mainMenu());
    await sendCatalog(chatId);
    return;
  }
  if (data === "catalog") return sendCatalog(chatId);
  if (data.startsWith("product:")) return showProduct(chatId, Number(data.slice(8)));
  if (data.startsWith("buy:")) return createOrder(chatId, query.message ?? { message_id: 0, chat: { id: chatId }, from: { id: chatId } }, Number(data.slice(4)));
  if (data === "my_orders") {
    const orders = await db.select().from(ordersTable).where(eq(ordersTable.telegramLookupHash, lookupHash(String(chatId)))).orderBy(desc(ordersTable.createdAt)).limit(10);
    await sendMessage(chatId, orders.length ? orders.map((order) => `#${order.id} · ${decrypt(order.productNameEncrypted)} · ${order.city} · ${order.status === "approved" ? "выдан" : order.status === "rejected" ? "отклонён" : "ожидает проверки"}`).join("\n") : "Заказов пока нет.", mainMenu());
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
  if (data.startsWith("support:reply:")) {
    const ticketId = Number(data.slice("support:reply:".length));
    if (!Number.isInteger(ticketId)) return;
    wizard.set(String(chatId), { stage: "supportReply", ticketId });
    await sendMessage(chatId, `Напишите ответ для обращения #${ticketId}.`);
    return;
  }
  if (data.startsWith("support:close:")) {
    const ticketId = Number(data.slice("support:close:".length));
    if (!Number.isInteger(ticketId)) return;
    await db.update(supportTicketsTable).set({ status: "closed", updatedAt: new Date() }).where(eq(supportTicketsTable.id, ticketId));
    await sendMessage(chatId, `Обращение #${ticketId} закрыто.`);
    return;
  }
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
    const cards = await db.select().from(paymentCardsTable).where(eq(paymentCardsTable.active, true)).orderBy(desc(paymentCardsTable.id));
    await sendMessage(chatId, `<b>Инструкции по оплате</b>\n\n${decrypt(settings.paymentInstructions) || settings.paymentInstructions}\n\nАктивных карт: ${cards.length}\nДобавить карту: /addcard\nСписок карт: /cards\nИзменение текста: /setpayment новый текст`);
    return;
  }
  if (data === "admin:cards") {
    await handleOwnerCommand(chatId, "/cards", { message_id: 0, chat: { id: chatId }, from: { id: chatId }, text: "/cards" });
    return;
  }
  if (data === "admin:support") {
    await sendSupportQueue(chatId);
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
      await sendMessage(chatId, "<b>HASKIBOTRAIN</b>\n\nВыберите город, затем позицию. Выдача происходит после ручной проверки оплаты.", mainMenu());
      if (text === "/start") await sendMessage(chatId, "Выберите город получения:", cityMenu());
      else await sendCatalog(chatId);
      return;
    }
    if (text === "/owner") {
      await sendMessage(chatId, "Панель доступна только владельцу.");
      return;
    }
  }
  const owner = await ownerId();
  if (owner !== chatId && text && !text.startsWith("/")) {
    const [ticket] = await db.insert(supportTicketsTable).values({
      customerNameEncrypted: encrypt(message.from?.first_name ?? "Telegram user"),
      usernameEncrypted: message.from?.username ? encrypt(`@${message.from.username}`) : null,
      telegramLookupHash: lookupHash(String(chatId)),
      telegramIdEncrypted: encrypt(String(chatId)),
      topic: "Сообщение покупателя",
      status: "open",
      lastMessageEncrypted: encrypt(text),
    }).returning();
    await sendMessage(chatId, "Сообщение передано в поддержку.", mainMenu());
    if (ticket) void notifyOwnerSupport(ticket.id);
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