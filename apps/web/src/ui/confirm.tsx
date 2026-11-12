// The shared question (v3 DS-12, DS-20, FW-8): a small dialog from the dialog builder with a title,
// a message that names the object, the count and the consequence, and two buttons. The confirm
// button takes the focus, so Enter confirms; a question that protects work starts on its safe
// answer. Escape, Back, a click outside and a pull down on a phone all cancel.

import { useEffect, useRef, useState } from "react"
import { useI18n } from "../i18n/i18n.tsx"
import { Dialog } from "./Dialog.tsx"

export type ConfirmOptions = {
  title: string
  message: string
  confirmText: string
  cancelText?: string
  /** A destructive action: the confirm button is solid red. */
  danger?: boolean
  /** A question that drops work (Discard, Leave) starts on the safe button. */
  focusCancel?: boolean
  /** Asked during Back or Forward: adds no history entry of its own. */
  noHistory?: boolean
}

type Pending = ConfirmOptions & { id: number; resolve: (answer: boolean) => void }

let ask: ((pending: Pending) => void) | null = null
let drop: ((id: number) => void) | null = null
let dropAll: (() => void) | null = null
let nextId = 1

/**
 * Cancels the open question, whoever asked it: the signed-in identity changed, so an answer must not reach an action
 * the previous identity started.
 */
export function dismissQuestions(): void {
  dropAll?.()
}

/** A question asked, and what takes it away unanswered (as Cancel) when it no longer applies. */
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
      // A second question replaces the first, which counts as cancelled.
      setPending((current) => {
        current?.resolve(false)
        return next
      })
    }
    // Only the question with this id: a newer one stays.
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

/**
 * Closes a dialog with typed input, asking first when something was typed (v3 DS-9). `dismiss` takes away a question
 * still open for this dialog: a save that succeeds while it is open closes the dialog and the question with it.
 */
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
