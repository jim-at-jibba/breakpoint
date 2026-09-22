import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useState } from 'react'
import { describeCertificateError, type TrustedCertificate } from '../../../shared/certificates'

/**
 * The certificate decisions this machine holds, in settings, where PRD 8.8 says they
 * belong. Each is one host and one fingerprint ([ADR-0012]): forgetting one makes that
 * certificate ask again the next time it is served, and leaves every other decision —
 * including another certificate on the same host — exactly as it was.
 *
 * Global rather than a project's, which is why the list is not keyed by the open project
 * and does not empty when one closes.
 */
export function TrustedCertificates({
  certificates
}: {
  certificates: readonly TrustedCertificate[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function forget(certificate: TrustedCertificate): Promise<void> {
    setMessage(null)
    try {
      const response = await window.breakpoint.invoke('certificates.forget', {
        host: certificate.host,
        fingerprint: certificate.fingerprint
      })
      if (!response.ok) setMessage(response.error.message)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        setMessage(null)
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="outline"
            title="The certificates you have trusted on this machine"
            aria-label="Trusted certificates"
            data-testid="trusted-certificates"
          >
            Certificates {certificates.length}
          </Button>
        }
      />
      <PopoverContent align="end" data-testid="trusted-certificates-menu">
        <div className="flex flex-col">
          <p className="px-[var(--bp-space-2)] pb-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]">
            Certificates you trusted, kept against the host and the certificate itself. A dev server
            on this machine is never asked about and is not listed.
          </p>
          {certificates.length === 0 && (
            <span
              className="px-[var(--bp-space-2)] py-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink-faint)]"
              data-testid="trusted-certificates-empty"
            >
              No certificates trusted.
            </span>
          )}
          {certificates.map((certificate) => (
            <div
              key={`${certificate.host} ${certificate.fingerprint}`}
              data-testid="trusted-certificate"
              data-host={certificate.host}
              data-fingerprint={certificate.fingerprint}
              className="flex items-center gap-[var(--bp-space-3)] rounded-[var(--bp-radius-sm)] px-[var(--bp-space-2)] py-[var(--bp-space-2)] hover:bg-[var(--bp-hover)]"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-[length:var(--bp-text-sm)] text-[color:var(--bp-ink)]">
                  {certificate.host}
                </span>
                <span
                  title={certificate.fingerprint}
                  className="truncate font-mono text-[length:var(--bp-text-micro)] text-[color:var(--bp-ink-faint)]"
                >
                  {certificate.fingerprint}
                </span>
                <span className="truncate text-[length:var(--bp-text-micro)] text-[color:var(--bp-ink-faint)]">
                  {describeCertificateError(certificate.error)}
                </span>
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Forget ${certificate.host}`}
                data-testid="forget-certificate"
                data-host={certificate.host}
                className="flex-none text-[color:var(--bp-ink-faint)]"
                onClick={() => void forget(certificate)}
              >
                ×
              </Button>
            </div>
          ))}
        </div>
        {message !== null && (
          <span
            role="alert"
            data-testid="trusted-certificates-error"
            className="px-[var(--bp-space-2)] text-[length:var(--bp-text-sm)] text-[color:var(--bp-error)]"
          >
            {message}
          </span>
        )}
      </PopoverContent>
    </Popover>
  )
}
