import type { Locale } from "@maane/shared"
import { and, eq, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { pushSubscription } from "../db/schema.ts"
import { Refusal } from "../organizations/refusal.ts"
import { pushEndpointAllowed, subscriptionKeysValid } from "./push.ts"

export type SubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string }; locale: Locale }

export class Subscriptions {
  constructor(private readonly db: Db) {}

  async isOn(userId: string, endpoint: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: pushSubscription.id })
      .from(pushSubscription)
      .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
    return row !== undefined
  }

  async setLocale(userId: string, endpoint: string, locale: Locale): Promise<boolean> {
    const rows = await this.db
      .update(pushSubscription)
      .set({ locale })
      .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
      .returning({ id: pushSubscription.id })
    return rows.length > 0
  }

  async subscribe(userId: string, input: SubscriptionInput): Promise<void> {
    if (!pushEndpointAllowed(input.endpoint)) throw new Refusal("push_endpoint_refused", 400)
    if (!subscriptionKeysValid(input.keys.p256dh, input.keys.auth)) throw new Refusal("push_subscription_invalid", 400)
    const rows = await this.db
      .insert(pushSubscription)
      .values({
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        locale: input.locale,
      })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: { p256dh: input.keys.p256dh, auth: input.keys.auth, locale: input.locale, updatedAt: sql`now()` },
        setWhere: eq(pushSubscription.userId, userId),
      })
      .returning({ id: pushSubscription.id })
    if (rows.length === 0) throw new Refusal("push_endpoint_taken", 409)
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.db
      .delete(pushSubscription)
      .where(and(eq(pushSubscription.userId, userId), eq(pushSubscription.endpoint, endpoint)))
  }
}
