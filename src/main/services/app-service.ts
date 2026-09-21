import { app } from 'electron'

/**
 * The app itself, as a service. `app.*` routes are not one of the seven services in
 * PRD 8.1 — they act on the process rather than on panes, projects or logs — but they go
 * through a service all the same, so no adapter ever holds behaviour ([ADR-0005]).
 */
export class AppService {
  quit(): void {
    app.quit()
  }
}
