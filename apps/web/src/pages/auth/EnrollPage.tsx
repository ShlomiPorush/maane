import { useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Navigate, useNavigate, useSearchParams } from "react-router"
import { ApiError } from "../../api/client.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { peekEnrollmentPassword, safeNext, useMe, withNext } from "../../shell/session.ts"
import { useSignOut } from "../../shell/signOut.ts"
import { ErrorState, Loading } from "../../ui/states.tsx"
import { usePageTitle } from "../usePageTitle.ts"
import { AuthFrame, BackupCodes } from "./parts.tsx"
import { TotpStep } from "./TotpStep.tsx"

export function EnrollPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [params] = useSearchParams()
  const next = safeNext(params.get("next"))
  const me = useMe({ fresh: true })
  const signOut = useSignOut()
  const [known] = useState(peekEnrollmentPassword)
  const [codes, setCodes] = useState<string[] | null>(null)
  usePageTitle(codes ? t("enroll.codesTitle") : t("enroll.title"))

  if (codes)
    return (
      <AuthFrame title={t("enroll.codesTitle")} description={t("enroll.codesDescription")}>
        <BackupCodes
          codes={codes}
          doneLabel={t("enroll.continue")}
          onDone={() => {
            void queryClient.resetQueries().then(() => navigate(next, { replace: true }))
          }}
        />
      </AuthFrame>
    )
  if (me.isPending || me.isFetching) return <Loading label={t("app.loading")} />
  const error = me.error
  if (error instanceof ApiError && error.status === 401) return <Navigate to={withNext("/login", next)} replace />
  if (!error && me.data) return <Navigate to={next} replace />
  if (!(error instanceof ApiError && error.code === "totp_required"))
    return (
      <div className="ui-auth">
        <ErrorState title={t("app.unreachable")} error={error} onRetry={() => void me.refetch()} />
      </div>
    )
  return (
    <AuthFrame title={t("enroll.title")} description={t("enroll.description")}>
      <TotpStep known={known} onEnrolled={setCodes} />
      <div className="ui-auth-note">
        <p>{t("enroll.required")}</p>
        <button type="button" className="ui-btn" onClick={() => void signOut()}>
          {t("account.signOut")}
        </button>
      </div>
    </AuthFrame>
  )
}
