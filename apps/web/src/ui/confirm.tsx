import { useEffect, useRef, useState } from "react"
import { useI18n } from "../i18n/i18n.tsx"
import { Dialog } from "./Dialog.tsx"

export type ConfirmOptions = {
  title: string
  message: string
  confirmText: string
  cancelText?: string
  danger?: boolean
  focusCancel?: boolean
  noHistory?: boolean
}

type Pending = ConfirmOptions & { id: number; resolve: (answer: boolean) => void }

let ask: ((pending: Pending) => void) | null = null
let drop: ((id: number) => void) | null = null
let dropAll: (() => void) | null = null
let nextId = 1

export function dismissQuestions(): void {
  dropAll?.()
}

export type Question = { answer: Promise<boolean>; dismiss: () => void }

export function askQuestion(options: ConfirmOptions): Question {
  const id = nextId++
  const answer = new Promise<boolean>((resolve) => {
    if (!ask) {
      resolve(false)
      return
    }
    ask({ ...options, id, resolve })
  })
  return { answer, dismiss: () => drop?.(id) }
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return askQuestion(options).answer
}

export function ConfirmHost() {
  const { t } = useI18n()
  const [pending, setPending] = useState<Pending | null>(null)

  useEffect(() => {
    ask = (next) => {
      setPending((current) => {
        current?.resolve(false)
        return next
      })
    }
    drop = (id) => {
      setPending((current) => {
        if (current?.id !== id) return current
        current.resolve(false)
        return null
      })
    }
    dropAll = () => {
      setPending((current) => {
        current?.resolve(false)
        return null
      })
    }
    return () => {
      ask = null
      drop = null
      dropAll = null
    }
  }, [])

  if (!pending) return null
  const answer = (value: boolean) => {
    pending.resolve(value)
    setPending((current) => (current?.id === pending.id ? null : current))
  }
  return (
    <Dialog
      key={pending.id}
      role="alertdialog"
      size="sm"
      title={pending.title}
      onCancel={() => answer(false)}
      backdropClose
      noHistory={pending.noHistory}
      foot={
        <>
          <button
            type="button"
            className="ui-btn"
            data-cancel=""
            data-autofocus={pending.focusCancel ? "" : undefined}
            onClick={() => answer(false)}
          >
            {pending.cancelText ?? t("common.cancel")}
          </button>
          <button
            type="button"
            className={pending.danger ? "ui-btn ui-btn-danger-solid" : "ui-btn ui-btn-primary"}
            data-autofocus={pending.focusCancel ? undefined : ""}
            onClick={() => answer(true)}
          >
            {pending.confirmText}
          </button>
        </>
      }
    >
      <p className="ui-confirm-text">{pending.message}</p>
    </Dialog>
  )
}

export function useDiscardGuard(dirty: boolean, close: () => void): (() => Promise<void>) & { dismiss: () => void } {
  const { t } = useI18n()
  const open = useRef<Question | null>(null)
  const guarded = async () => {
    if (dirty) {
      const question = askQuestion({
        title: t("unsaved.discardTitle"),
        message: t("unsaved.discardMessage"),
        confirmText: t("unsaved.discard"),
        cancelText: t("unsaved.keepEditing"),
        focusCancel: true,
      })
      open.current = question
      const discard = await question.answer
      if (open.current === question) open.current = null
      if (!discard) return
    }
    close()
  }
  return Object.assign(guarded, {
    dismiss: () => {
      open.current?.dismiss()
      open.current = null
    },
  })
}
