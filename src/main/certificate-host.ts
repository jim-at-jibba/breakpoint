import type { App, Session, WebContents } from 'electron'
import { certificateKey, type CertificateKey } from '../shared/certificates'
import type { CertificateService } from './services/certificate-service'

/** The Electron side of certificate trust: load lifetimes and accepted connections. */
export class CertificateHost {
  // Sessions outlive their guests. Keep accepted sessions even after a project closes,
  // otherwise reopening it could reuse a connection whose decision was forgotten.
  private readonly accepted = new Map<string, Set<Session>>()

  install(app: App, certificates: CertificateService): void {
    app.on('certificate-error', (event, contents, url, error, certificate, callback) => {
      event.preventDefault()
      const key = certificateKey({
        host: new URL(url).hostname,
        fingerprint: certificate.fingerprint
      })
      const session = contents.session
      let cleanup = (): void => {}
      const cancel = certificates.verify(
        {
          url,
          error,
          data: certificate.data,
          fingerprint: certificate.fingerprint,
          subjectName: certificate.subject.commonName,
          issuerName: certificate.issuer.commonName
        },
        (trusted) => {
          cleanup()
          if (trusted) {
            const sessions = this.accepted.get(key) ?? new Set<Session>()
            sessions.add(session)
            this.accepted.set(key, sessions)
          }
          callback(trusted)
        }
      )
      if (cancel) cleanup = watchLoad(contents, cancel)
    })
  }

  async revokeConnections(key: CertificateKey): Promise<void> {
    const name = certificateKey(key)
    const sessions = this.accepted.get(name)
    if (!sessions) return
    // Electron exposes session-wide closure, not per-host closure. Other in-flight
    // requests in these sessions can fail too; unrelated sessions are left alone.
    await Promise.all([...sessions].map((session) => session.closeAllConnections()))
    this.accepted.delete(name)
  }
}

/** Same-document moves do not replace the load whose certificate is waiting. */
function watchLoad(contents: WebContents, cancel: () => void): () => void {
  const navigate = (
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (event.isMainFrame && !event.isSameDocument) cancel()
  }
  contents.on('did-start-navigation', navigate)
  contents.once('did-stop-loading', cancel)
  contents.once('destroyed', cancel)
  return () => {
    contents.removeListener('did-start-navigation', navigate)
    contents.removeListener('did-stop-loading', cancel)
    contents.removeListener('destroyed', cancel)
  }
}
