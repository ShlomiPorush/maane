// The notifications of this device, on the Account page (plan 4.5): on or off for the signed-in user in this browser.
// Turning them on asks the browser's permission, subscribes with Maane's public key, and gives the server the
// subscription and the UI's language (the notification's words); the server keeps it as the user's. Turning them off
// deletes it on the server, then ends it in the browser. A subscription the browser holds but the server does not
// count as the user's (another account's, or one the server deleted) shows as off, and turning on replaces it.

import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { api, qk } from "../api/endpoints.ts"
import { errorText } from "../api/errors.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { Group, Row } from "../pages/parts.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { showToast } from "../ui/Toast.tsx"
import { Tag } from "../ui/tags.tsx"
import { DeviceRefusal, type PushDevice, pushDevice } from "./device.ts"

type DeviceState =
  | { support: "unsupported" }
  | { support: "ok"; permission: NotificationPermission; publicKey: string; on: boolean }

async function readState(device: PushDevice): Promise<DeviceState> {
  if (!device.supported()) return { support: "unsupported" }
  const subscription = await device.current()
  const state = await api.notificationState(subscription?.endpoint ?? null)
  return {
    support: "ok",
    permission: device.permission(),
    publicKey: state.publicKey,
    on: state.on && subscription !== null,
  }
}

export function DeviceNotifications() {
  const { t, language } = useI18n()
  const queryClient = useQueryClient()
  const device = pushDevice()
  const query = usePageQuery({ queryKey: qk.notifications, queryFn: () => readState(device), every: EVERY.slow })
  const [busy, setBusy] = useState(false)
  const state = query.data

  const change = async (work: () => Promise<void>, done: string) => {
    setBusy(true)
    try {
      await work()
      showToast(done, "success")
    } catch (error) {
      if (error instanceof DeviceRefusal)
        showToast(t(error.reason === "blocked" ? "notifications.blocked" : "notifications.unsupported"), "error")
      else showToast(t("notifications.failed", { reason: errorText(t, error) }), "error")
    } finally {
      setBusy(false)
      await queryClient.invalidateQueries({ queryKey: qk.notifications })
    }
  }

  const turnOn = (publicKey: string) =>
    change(async () => {
      // A subscription the server does not count as this user's is replaced, never handed to them.
      await (await device.current())?.unsubscribe()
      const subscription = await device.subscribe(publicKey)
      await api.subscribeDevice(subscription, language)
    }, t("notifications.turnedOn"))

  const turnOff = () =>
    change(async () => {
      const subscription = await device.current()
      if (!subscription) return
      await api.unsubscribeDevice(subscription.endpoint)
      await subscription.unsubscribe()
    }, t("notifications.turnedOff"))

  // A new UI language while notifications are on: the next ones come in it.
  const shownLanguage = useRef(language)
  useEffect(() => {
    if (shownLanguage.current === language) return
    shownLanguage.current = language
    if (!(state?.support === "ok" && state.on)) return
    void (async () => {
      const subscription = await device.current()
      if (subscription) await api.subscribeDevice(subscription, language)
    })().catch(() => {
      // The words stay in the earlier language until notifications are turned on again; nothing else changes.
    })
  }, [language, state, device])

  return (
    <Group id="account-notifications" title={t("notifications.group")} intro={t("notifications.hint")}>
      {query.isPending ? <Loading label={t("notifications.loading")} /> : null}
      {query.isError && !state ? (
        <ErrorState title={t("notifications.checkFailed")} error={query.error} onRetry={() => void query.refetch()} />
      ) : null}
      <StaleNote failed={query.isError && Boolean(state)} />
      {state?.support === "unsupported" ? (
        <Row label={t("notifications.row")}>
          <span className="ui-set-value">{t("notifications.unsupported")}</span>
        </Row>
      ) : null}
      {state?.support === "ok" ? (
        <Row
          label={t("notifications.row")}
          hint={!state.on && state.permission === "denied" ? t("notifications.blocked") : undefined}
        >
          <span className="ui-set-value">
            <Tag tone={state.on ? "ok" : "neutral"}>{state.on ? t("notifications.on") : t("notifications.off")}</Tag>
          </span>
          {state.on ? (
            <button type="button" className="ui-btn" disabled={busy} onClick={() => void turnOff()}>
              {busy ? t("notifications.busy") : t("notifications.turnOff")}
            </button>
          ) : (
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={busy || state.permission === "denied"}
              onClick={() => void turnOn(state.publicKey)}
            >
              {busy ? t("notifications.busy") : t("notifications.turnOn")}
            </button>
          )}
        </Row>
      ) : null}
    </Group>
  )
}
