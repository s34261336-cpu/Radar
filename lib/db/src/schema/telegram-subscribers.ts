import { timestamp, pgTable, text } from "drizzle-orm/pg-core";

export const telegramSubscribers = pgTable("telegram_subscribers", {
  chatId: text("chat_id").primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type TelegramSubscriber = typeof telegramSubscribers.$inferSelect;