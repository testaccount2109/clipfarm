# Clipfarm – Sicherheitsprüfung

Prüfdatum: 02.10.2026

## Zusammenfassung

Die öffentliche Clipfarm-API antwortet, HTTPS-Zertifikatsprüfung ist erfolgreich, und unautorisierte Session-Zugriffe werden mit `401` abgelehnt. Der Electron-Renderer läuft mit Sandbox, Context Isolation, deaktiviertem Node-Zugriff und einer restriktiven Content-Security-Policy. `npm audit` meldet keine bekannten Abhängigkeitsschwachstellen. Es wurde keine kritische oder hohe Schwachstelle im lokal verfügbaren Quellcode bestätigt.

Zwei Betriebsrisiken bleiben offen: Die Authentifizierungs-Drosselung vertraut auf `X-Real-IP`, dessen Überschreiben durch Nginx hier nicht überprüfbar war; außerdem begrenzt der API-Code die Größe einzelner Uploads, aber keine gesamte Speichermenge pro Konto. Die Produktionskonfiguration und der Serverprozess selbst konnten mangels SSH-Konfiguration und SSH-Zugang nicht untersucht oder aktualisiert werden.

## Mittlere Risiken

### CF-001 – Proxy-Header muss für die Login-Drosselung vertrauenswürdig gesetzt werden

- **Ort:** `backend/server.js`, Zeilen 116–123
- **Evidenz:** Der Rate-Limit-Schlüssel wird aus `request.headers["x-real-ip"]` gebildet. Der Dienst bindet laut Zeile 14 an `127.0.0.1` und erwartet laut `backend/README.md` Nginx als Reverse Proxy.
- **Auswirkung:** Falls Nginx den Header unverändert vom Internet-Client übernimmt, kann ein Angreifer bei Login- und Registrierungsversuchen pro Anfrage eine andere IP vortäuschen und die Drosselung umgehen.
- **Empfohlene Behebung:** In der tatsächlichen Nginx-Konfiguration `X-Real-IP` immer mit `$remote_addr` überschreiben und prüfen, dass der API-Port nur lokal erreichbar ist.
- **Status:** Nicht verifiziert. Die Nginx-Konfiguration des Produktionsservers liegt lokal nicht vor.

### CF-002 – Keine aggregierte Upload- oder Kontingentgrenze

- **Ort:** `backend/server.js`, Zeilen 20 und 273–319
- **Evidenz:** Einzelne MP4-Dateien sind auf 2 GB begrenzt; im Uploadpfad ist keine Gesamtgrenze pro Benutzer oder pro Server konfiguriert. Medien sind laut `README.md` per zufälliger ID öffentlich abrufbar.
- **Auswirkung:** Ein angemeldetes Konto kann wiederholt große Dateien hochladen und dadurch den verfügbaren Speicher des Hosts erschöpfen.
- **Empfohlene Behebung:** Ein Server-Kontingent pro Konto und eine globale Speichergrenze mit Alarmierung ergänzen; temporäre Uploads bei Fehlern und nach Ablauf bereinigen.
- **Status:** Im lokalen Quellcode sichtbar, auf dem laufenden Produktionsserver nicht geprüft oder geändert. Ein Kontingentwert ist produktseitig nicht festgelegt.

## Niedrige Risiken

### CF-003 – Renderer-Navigation war nicht auf den lokalen App-Ursprung begrenzt

- **Ort:** `electron-main.js`, Zeilen 471–477 in `createMainWindow()`
- **Evidenz:** Vor der Änderung wurde `window.open` blockiert, aber es gab keinen `will-navigate`-Filter für die Hauptnavigation.
- **Auswirkung:** Eine versehentliche oder durch künftig hinzugefügte UI-Inhalte ausgelöste Navigation könnte den lokalen Renderer verlassen. IPC-Aufrufe lehnen fremde Ursprünge bereits ab, aber die Navigation sollte selbst blockiert werden.
- **Behebung:** `will-navigate` blockiert nun Ziele außerhalb des aktuellen lokalen App-Ursprungs.
- **Status:** Behoben.

## Geprüfte Schutzmaßnahmen und Laufzeit

- `electron-main.js` setzt `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` und `webSecurity: true`; externe Popups werden blockiert.
- `server.js` bindet den lokalen Host an `127.0.0.1` und setzt eine CSP. `backend/server.js` bindet den Community-Dienst ebenfalls standardmäßig an `127.0.0.1`.
- Passwörter werden im Backend mit gesalzenem scrypt gehasht; die App hält Sitzungstoken im Hauptprozess und nutzt Windows `safeStorage`.
- API-Prüfung am 02.10.2026: `/api/v1/health` antwortete `200`, OpenAPI antwortete `200`, unauthentifiziertes `/api/v1/auth/session` antwortete `401` mit Bearer-Challenge. HTTP wurde mit `301` auf HTTPS umgeleitet. Die TLS-Zertifikatsprüfung von curl lieferte `0` (erfolgreich).
- Website-Root antwortete mit `401` und HTTP-Basic-Auth-Challenge; das entspricht der dokumentierten geschützten Website.
- `npm audit` und `npm audit --omit=dev` meldeten jeweils 0 bekannte Schwachstellen.
- Der laufende lokale App-Host antwortete auf `/api/health` mit `clipfarm-local-host` und zeigte Engine-Status `running`.

## Nicht verifizierbare Punkte

Der API-Health-Endpunkt bestätigt, dass ein API-Prozess Anfragen beantwortet; er belegt nicht den Zustand der systemd-Unit, SQLite-/Mediendateirechte, Secret-Dateirechte, Firewall-Regeln, Backups, Nginx-Uploadlimits oder Speicherreserven. Dafür ist ein Serverzugang nötig. Auf diesem Rechner wurden keine SSH-Konfiguration und keine geladenen SSH-Identitäten gefunden.
