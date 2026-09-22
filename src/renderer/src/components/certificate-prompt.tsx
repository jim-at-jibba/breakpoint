import { Button } from '@renderer/components/ui/button'
import { useState } from 'react'
import { describeCertificateErrors, type CertificateRequest } from '../../../shared/certificates'

/**
 * The one question Breakpoint asks about a page it is loading: this host's certificate
 * does not verify, do you want it anyway.
 *
 * Drawn on ground the app owns — a strip under the toolbar, above the canvas — and never
 * over a pane. A security question painted on a page is a question that page can imitate,
 * and the panes here are showing whatever the unverified host served.
 *
 * Everything the decision turns on is in the strip: the host, what is wrong with the
 * certificate in words, and the fingerprint the answer is keyed on ([ADR-0012]). One
 * question at a time, oldest first, because that is the one the panes are held by.
 */
export function CertificatePrompt({
  waiting
}: {
  waiting: readonly CertificateRequest[]
}): React.JSX.Element | null {
  const [message, setMessage] = useState<string | null>(null)
  const [deciding, setDeciding] = useState(false)
  const request = waiting[0]

  async function decide(trusted: boolean): Promise<void> {
    if (!request || deciding) return
    setDeciding(true)
    setMessage(null)
    try {
      const response = await window.breakpoint.invoke('certificates.decide', {
        host: request.host,
        fingerprint: request.fingerprint,
        trusted
      })
      if (!response.ok) setMessage(`${response.error.code}: ${response.error.message}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setDeciding(false)
    }
  }

  if (!request) return null
  const others = waiting.length - 1

  return (
    <section
      role="alertdialog"
      aria-label="Certificate"
      data-testid="certificate-prompt"
      data-host={request.host}
      data-fingerprint={request.fingerprint}
      className="flex shrink-0 flex-col gap-[var(--bp-space-1)] border-b border-[color:var(--bp-border)] bg-[color:var(--bp-warn-wash)] px-[var(--bp-space-5)] py-[var(--bp-space-3)]"
    >
      <div className="flex items-center gap-[var(--bp-space-4)]">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-[length:var(--bp-text-base)] text-[color:var(--bp-ink)]">
            <span className="font-mono">{request.host}</span> served a certificate{' '}
            {describeCertificateErrors(request)}. Panes waiting on it are held until you answer.
          </span>
          <span
            title={request.fingerprint}
            data-testid="certificate-prompt-fingerprint"
            className="truncate font-mono text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-muted)]"
          >
            {request.subject} · {request.fingerprint}
          </span>
        </div>
        {others > 0 && (
          <span
            data-testid="certificate-prompt-waiting"
            className="flex-none text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]"
          >
            {others} more waiting
          </span>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={deciding}
          data-testid="refuse-certificate"
          className="flex-none"
          onClick={() => void decide(false)}
        >
          Don’t trust
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={deciding}
          data-testid="trust-certificate"
          className="flex-none"
          onClick={() => void decide(true)}
        >
          Trust this certificate
        </Button>
      </div>
      {message !== null && (
        <span
          role="alert"
          data-testid="certificate-prompt-error"
          className="text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
        >
          {message}
        </span>
      )}
    </section>
  )
}
