import "flag-icons/css/flag-icons.min.css"
import type { ClickView, TrackedLinkView } from "@maane/shared"
import { formatNumber } from "../../format/number.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Time } from "../../ui/Time.tsx"
import { Tag } from "../../ui/tags.tsx"

function placeOf(click: ClickView, t: ReturnType<typeof useI18n>["t"]): string[] {
  const lines: string[] = []
  if (click.city) lines.push(t("links.city", { value: click.city }))
  if (click.region) lines.push(t("links.region", { value: click.region }))
  if (click.isp)
    lines.push(
      t("links.isp", {
        value: click.asn === null ? click.isp : `${click.isp} (${t("links.asn", { value: String(click.asn) })})`,
      }),
    )
  else if (click.asn !== null) lines.push(t("links.asn", { value: String(click.asn) }))
  return lines
}

function Click({ click }: { click: ClickView }) {
  const { t } = useI18n()
  const place = placeOf(click, t)
  const tooltip = place.length ? place.join("\n") : t("links.unknownPlace")
  const device = [click.device ? t(`links.device.${click.device}`) : null, click.browser, click.os].filter(Boolean)
  return (
    <li data-scanner={click.scanner.length ? "yes" : "no"}>
      {click.country ? (
        <span
          className={`fi fi-${click.country} ui-click-flag`}
          role="img"
          aria-label={t("links.country", { code: click.country.toUpperCase() })}
          title={t("links.country", { code: click.country.toUpperCase() })}
        />
      ) : (
        <span className="ui-click-flag ui-click-flag-none" aria-hidden="true" />
      )}
      <bdi className="ui-mono ui-click-ip" dir="ltr" title={tooltip}>
        {click.ip ?? t("links.noIp")}
      </bdi>
      <Time value={click.at} mode="full" />
      {device.length ? <span className="ui-muted">{device.join(" · ")}</span> : null}
      {click.scanner.length ? (
        <>
          <Tag tone="warn">{t("links.scanner")}</Tag>
          <span className="ui-muted">
            {click.scanner.map((reason) => t(`links.scannerReason.${reason}`)).join(" · ")}
          </span>
        </>
      ) : null}
      <span className="ui-click-place ui-muted">{place.length ? place.join(" · ") : t("links.unknownPlace")}</span>
    </li>
  )
}

export function Clicks({ links }: { links: TrackedLinkView[] }) {
  const { t, tc } = useI18n()
  return (
    <section className="ui-clicks" aria-label={t("links.title")}>
      <span className="ui-label">{t("links.title")}</span>
      <ul className="ui-clicks-links">
        {links.map((link) => (
          <li key={link.id} data-kind={link.kind}>
            <div className="ui-clicks-head">
              <Tag tone="neutral">{t(`links.kind.${link.kind}`)}</Tag>
              {link.kind === "url" ? (
                <bdi className="ui-mono ui-clicks-target" dir="ltr">
                  {link.target}
                </bdi>
              ) : (
                <bdi className="ui-clicks-target">{link.target}</bdi>
              )}
              <span className="ui-muted">{tc("links.count", link.total)}</span>
              <Time value={link.clicks[0]?.at} mode="full" />
            </div>
            {link.total > link.clicks.length ? (
              <p className="ui-muted ui-clicks-shown">
                {t("links.shown", { shown: formatNumber(link.clicks.length), total: formatNumber(link.total) })}
              </p>
            ) : null}
            <ul className="ui-clicks-list">
              {link.clicks.map((click) => (
                <Click key={click.id} click={click} />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  )
}
