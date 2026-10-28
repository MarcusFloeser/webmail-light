# Webmail – selbst gehosteter Mail-Client mit Kalender und Kontakten

Browser-Mailclient für mehrere Benutzer, komplett als Docker-Compose-Stack.

| Funktion | Umsetzung |
|---|---|
| IMAP-Sync | Lokaler Index in PostgreSQL; neueste *N* Nachrichten pro Ordner, ältere auf Knopfdruck. Flag-Abgleich über CONDSTORE/MODSEQ, wenn der Server es kann |
| Push | Dauerhafte IMAP-**IDLE**-Verbindung auf den Posteingang jedes Kontos → WebSocket an alle offenen Browser-Tabs, optional Desktop-Benachrichtigung. Übrige Ordner per STATUS-Polling (Standard 120 s) |
| Ordnerliste | Hierarchisch, Systemordner (SPECIAL-USE bzw. Namenserkennung DE/EN) zuerst, Ungelesen-Zähler, anlegen/umbenennen/löschen, Drag & Drop |
| Threads | Konversationen über References/In-Reply-To, **kontoweit über alle Ordner** (eigene Antworten aus „Gesendet“ erscheinen im Verlauf), Duplikate werden zusammengefasst, nachträgliches Zusammenführen wenn ein Bindeglied später eintrifft |
| CalDAV | Beliebig viele vorhandene CalDAV-Server pro Benutzer (Nextcloud, mailcow/SOGo, Radicale …); Monats-/Wochen-/Listenansicht, Serientermine (Intervall, Wochentage, Ende nach Datum/Anzahl; einzelne Termine einer Serie ändern oder löschen), empfangene Einladungen zusagen/ablehnen (iMIP, auch mit SOGo), Erinnerungen als Browser-Benachrichtigung |
| CardDAV | Adressbücher der eingebundenen Server, Kontakte inkl. Adressen bearbeiten (unbekannte vCard-Felder bleiben erhalten), Adress-Autovervollständigung beim Schreiben |
| Benutzerverwaltung | Übersicht für Admins mit letzter Anmeldung (Tooltip: zuletzt aktiv) und Mailbox-Belegung je Benutzer – per IMAP QUOTA vom Mailserver (z. B. Dovecot mit Quota-Plugin), sonst als „ca.“ aus den synchronisierten Nachrichten geschätzt; Aktualisierung alle 30 Min. |
| Mehrbenutzer | Anmeldung direkt mit den IMAP-Zugangsdaten (`AUTH_MODE=imap`, Benutzer + Postfach werden beim ersten Login angelegt) oder eigene Benutzerverwaltung; jeder Benutzer sieht nur seine Daten |
| Mehrere Konten | Beliebig viele IMAP/SMTP-Konten pro Benutzer, je eigener Sync-Worker |
| Mehrere Identitäten | Pro Konto beliebig viele Absender (Name, Adresse, Reply-To, Auto-Bcc, Signatur). Antworten wählen automatisch die Identität, an die die Mail ging |

Außerdem: Favoriten-Ordner (per Rechtsklick oder Stern oben in der Ordnerliste anpinnen, auch kontoübergreifend; im Profil gespeichert), HTML-Mails in einer Sandbox ohne Skripte, externe Bilder standardmäßig blockiert (bei Absendern aus den eigenen Kontakten automatisch angezeigt, abschaltbar im Profil; sonst pro Absender freigebbar), einklappbare Terminspalte rechts in der Mail-Ansicht mit den Terminen der nächsten 4 Wochen, Signatur-Editor mit Formatierung, Farben, Links und Logo (Bilder werden als eingebettete CID-Bilder versendet; HTML-Quelltext umschaltbar), Empfänger als Adress-Chips (Name + Adresse, per Drag & Drop zwischen An/Cc/Bcc verschiebbar), Rich-Text-Editor, Anhänge (auch per Drag & Drop), Entwürfe mit Autosave, Weiterleiten inkl. Anhängen oder als .eml, Drucken bzw. als PDF speichern (einzelne Nachricht, ganze Konversation oder mehrere ausgewählte; auch mit Strg+P), Suche, Tastenkürzel, Dark Mode, Mobil-Layout, verschiebbare Spaltentrenner (Breiten pro Browser gespeichert, Doppelklick = Standard), Farbschema automatisch/hell/dunkel, eigene Hintergrundfarbe und eigenes Hintergrundbild pro Benutzer (Einstellungen → Darstellung; Schrift wird automatisch hell/dunkel gewählt; Mail-Liste, Kontakte, Kalender und Einstellungen optional in derselben Farbe).

## Architektur

```
Browser ──HTTPS──► Nginx ──HTTP/WebSocket──► app (Node.js 22)
                             ├── PostgreSQL 16 (Benutzer, Konten, Ordner, Nachrichtenindex, Threads)
                             ├── IMAP/SMTP der Mailanbieter (pro Konto 2 IMAP-Verbindungen)
                             └── CalDAV/CardDAV-Server der Benutzer (Kalender & Kontakte bleiben dort)
```

- **app**: Express-API, `imapflow` (IMAP inkl. IDLE), `mailparser`, `nodemailer`, eigener schlanker DAV-Client, `ical.js` für Wiederholungen.
- **db** hängt in einem Netz ohne Internetzugang; nur die App ist erreichbar.
- Mail-Inhalte werden nicht dauerhaft gespeichert, nur Kopfdaten/Flags. Der Body wird beim Öffnen vom IMAP-Server geholt (kleiner RAM-Cache).
- IMAP-, SMTP- und DAV-Passwörter liegen AES-256-GCM-verschlüsselt in der Datenbank (Schlüssel = `SECRET_KEY`).

## Installation

```bash
cp .env.example .env
# Pflichtwerte setzen:
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
sed -i "s/^SECRET_KEY=.*/SECRET_KEY=$(openssl rand -hex 32)/" .env

docker compose up -d --build
docker compose logs app | grep -A2 Administrator   # generiertes Admin-Passwort
```

Dann die Seite über deinen Nginx öffnen (siehe unten), als `admin` anmelden, unter **Einstellungen → E-Mail-Konten** ein Konto hinzufügen (für Gmail, GMX, WEB.DE, iCloud, Posteo, mailbox.org, Fastmail, Yahoo, Bluewin werden die Server automatisch eingetragen) und unter **Benutzer** weitere Personen anlegen.

### Hinter Nginx (HTTPS)

Die App lauscht auf `127.0.0.1:8080`. Eine fertige Nginx-Konfiguration liegt in `nginx/webmail.conf` (Domain und Zertifikatspfade anpassen). Wichtig darin:

- `/ws` mit `Upgrade`/`Connection`-Headern und langem `proxy_read_timeout` (Push)
- `client_max_body_size 40m` für Anhänge

In `.env` bleiben `COOKIE_SECURE=true` und `TRUST_PROXY=true` gesetzt (Standard in `.env.example`). Läuft Nginx auf einem anderen Host, `HTTP_BIND` auf die passende Adresse setzen und `proxy_pass` anpassen.

## Anmeldung mit IMAP-Zugangsdaten

Mit `AUTH_MODE=imap` meldet man sich mit E-Mail-Adresse und Passwort des Mailservers an. Welcher Server gilt, bestimmt die **Domain-Konfiguration** (siehe unten):

- Beim **ersten Login** wird der Webmail-Benutzer angelegt und das Postfach automatisch als E-Mail-Konto mit Standard-Identität eingerichtet (SMTP über `AUTH_SMTP_*`, gleiche Zugangsdaten).
- Ändert sich das Passwort am Mailserver, übernimmt Webmail es beim nächsten Login für das Postfach.
- Angemeldet wird immer mit der **vollständigen E-Mail-Adresse** (Logins ohne `@` werden abgelehnt). Ausnahme: lokal angelegte Benutzer wie der Notfall-Admin (`ADMIN_USERNAME`) mit ihrem Benutzernamen.
- Admin-Rechte bekommen die Logins in `AUTH_ADMINS`.
- **„Angemeldet bleiben“** (auf der Anmeldeseite, standardmässig aktiv): Die Sitzung bleibt `SESSION_DAYS` Tage (Standard 30) nach der letzten Nutzung bestehen und verlängert sich bei jeder Nutzung. Ohne Häkchen endet sie beim Schliessen des Browsers bzw. nach `SESSION_IDLE_HOURS` Stunden ohne Aktivität. Der Browser merkt sich nur den Benutzernamen, nie das Passwort. Auf gemeinsam genutzten Geräten das Häkchen entfernen bzw. abmelden.
- Mit `AUTH_DAV_URL` wird zusätzlich ein CalDAV/CardDAV-Server mit denselben Zugangsdaten eingebunden (z. B. Nextcloud oder SOGo, wenn dort dieselben Logins gelten).
- Lokale Benutzer (z. B. ein Notfall-Admin mit `ADMIN_PASSWORD`, oder in der Benutzerverwaltung angelegte) melden sich weiterhin mit ihrem eigenen Passwort an. Ist der Mailserver nicht erreichbar, zeigt der Login das an, statt „Passwort falsch“ zu melden.

## Domains & Mailserver (zentrale Konfiguration)

Unter **Benutzer → Domains & Mailserver** (nur Admins) wird pro Domain fest eingestellt, mit welchem Mailserver Webmail verbindet:

| Feld | Bedeutung |
|---|---|
| Domain | z. B. `example.ch` – oder `*` für alle übrigen Domains (Standard) |
| Posteingang (IMAP) | Server (Name oder IP), Port, Verschlüsselung (automatisch nach Port, SSL/TLS, STARTTLS, keine) |
| Postausgang (SMTP) | dito – mit denselben Zugangsdaten wie IMAP |
| Benutzername am Mailserver | vollständige E-Mail-Adresse oder nur Teil vor dem `@` |
| Kalender & Kontakte | optionaler CalDAV/CardDAV-Server, beim Login automatisch eingebunden |
| Zertifikate | „Ungültige/selbstsignierte akzeptieren“ für interne Server |

- So lassen sich **interne Domains** (z. B. `192.168.1.23:143`) und **externe Domains** (z. B. `mail.partner.ch:993`) nebeneinander betreiben. Die Domain der E-Mail-Adresse wählt den Server – beim Login und beim Hinzufügen weiterer Konten.
- **Endbenutzer sehen keine Serverdaten** (Adresse, Port, Verschlüsselung) – weder in den Einstellungen noch in Fehlermeldungen. Neue Konten legen sie nur mit E-Mail-Adresse und Passwort an.
- **Änderungen** an einer Domain werden sofort auf alle zugehörigen Konten übertragen; die Konten verbinden neu.
- **Verbindung testen**: ohne Zugangsdaten nur Erreichbarkeit (Begrüssung von IMAP/SMTP), mit Test-Adresse + Passwort zusätzlich die Anmeldung.
- **Eigene Mailserver** (z. B. Gmail) dürfen Benutzer nur einrichten, wenn der Admin die Option „Benutzer dürfen zusätzliche Konten bei anderen Mailservern einrichten“ aktiviert (Standard: aus). Bereits bestehende eigene Konten bleiben erhalten.
- **Umstellung bestehender Installationen**: Beim ersten Start mit dieser Version wird aus `AUTH_IMAP_*` / `AUTH_SMTP_*` / `AUTH_DAV_URL` (.env) automatisch die Standard-Domain `*` angelegt. Alle bestehenden Konten auf diesem Server – und alle Konten, deren Domain eingerichtet ist – werden ihr zugeordnet. Danach werden die `AUTH_IMAP_*`/`AUTH_SMTP_*`-Werte nicht mehr verwendet; Änderungen erfolgen in der Oberfläche.

## Passwort ändern und „Passwort vergessen“ (LDAP)

Liegen die Passwörter in einem LDAP-Verzeichnis (OpenLDAP, 389-DS, FreeIPA, Active Directory), bietet Webmail:

- **Profil → Passwort ändern**: Der Benutzer meldet sich mit dem alten Passwort am LDAP an und setzt das neue (Standard: *Password Modify Extended Operation*, RFC 3062 – der Server hasht selbst und prüft seine Passwort-Richtlinie). Danach werden die in Webmail gespeicherten Passwörter für Postfach und Kalender-Server automatisch angepasst.
- **Anmeldeseite → „Passwort vergessen?“**: Webmail sucht den Benutzer per Dienstkonto im LDAP und schickt einen Link (gültig 30 Min., nur einmal verwendbar, nur als Hash gespeichert) an die **Ersatz-Adresse** aus `LDAP_RECOVERY_ATTRS` (z. B. `mailAlternateAddress`). Die Antwort ist immer gleich, damit sich nicht prüfen lässt, ob ein Konto existiert; Anfragen sind begrenzt. Nach dem Zurücksetzen werden alle Sitzungen des Benutzers beendet.

Nötig dafür: `LDAP_URL`, `LDAP_BASE_DN` (oder `LDAP_USER_DN_TEMPLATE`), ein Dienstkonto `LDAP_BIND_DN`/`LDAP_BIND_PASSWORD` mit Schreibrecht auf das Passwort-Attribut, `SYSTEM_SMTP_*` für den Versand und `PUBLIC_URL` (wird bewusst nicht aus dem Host-Header abgeleitet). Beispiel-ACL für OpenLDAP:

```
olcAccess: to attrs=userPassword
  by self write
  by dn.exact="cn=webmail,ou=services,dc=example,dc=com" write
  by anonymous auth
  by * none
```

Laufen LDAP und Mailserver als Container in einem eigenen Docker-Netz, kann die Verbindung unverschlüsselt erfolgen (`LDAP_URL=ldap://openldap:389`, `LDAP_STARTTLS=false`, bzw. `AUTH_IMAP_SECURITY=none`). Die Anbindung an das bestehende Netz zeigt `docker-compose.override.yml.example`.

Verbindung prüfen: `docker compose exec app node src/tools/ldap-check.js marcus` – zeigt Schritt für Schritt Verbindung, Verschlüsselung, Dienstkonto und gefundenen Benutzer.

Ohne LDAP-Konfiguration kann mit `PASSWORD_HELP_TEXT` ein Hinweis („Wende dich an …“) hinter „Passwort vergessen?“ hinterlegt werden.

## Speicherplatz

Unter jedem Konto in der Ordnerleiste und in den Kontoeinstellungen sieht der Benutzer, wie viel Platz sein Postfach belegt („700 MB von 5 GB“), als Balken: grün, ab `QUOTA_WARN_PERCENT` (80 %) orange, ab `QUOTA_FULL_PERCENT` (95 %) rot – mit einem Hinweis, wie man Platz schafft. Die Werte kommen vom Mailserver (IMAP QUOTA, bei mailcow vorhanden), werden alle 15 Minuten und nach „Papierkorb leeren“ aktualisiert und lassen sich in den Kontoeinstellungen sofort neu abfragen. Der Admin sieht dieselben Balken in der Benutzerübersicht.

## Filter & Abwesenheitsnotiz

Unter **Einstellungen → Filter & Abwesenheit** richtet jeder Benutzer pro Konto ein:

- **Abwesenheitsnotiz** mit Betreff, Text, optionalem Zeitraum (von/bis – schaltet sich selbst ein und aus) und „höchstens alle n Tage pro Absender“. Sie antwortet auf alle Adressen des Kontos (inkl. Identitäten), nicht auf Spam, Newsletter und automatische Mails.
- **Filterregeln**: Wenn Absender / Empfänger / Cc / Betreff / beliebige Kopfzeile *enthält / enthält nicht / ist genau / ist nicht* … dann *in Ordner verschieben, als gelesen markieren, markieren, weiterleiten (auch mit Kopie), löschen*. Regeln lassen sich einzeln ein-/ausschalten und sortieren.

Die Regeln liegen als Sieve-Script „webmail“ direkt auf dem Mailserver (ManageSieve, RFC 5804) und wirken auch, wenn niemand eingeloggt ist – auch für Mails, die aufs Handy kommen. Der Mailserver prüft das Script beim Speichern.

**mailcow**: funktioniert ohne Zusatzkonfiguration (Dovecot, Port 4190, STARTTLS, gleiche Zugangsdaten). Den Port stellt der Admin pro Domain ein (*Benutzer → Domains & Mailserver*, Feld „Sieve-Port“, 0 = aus). Auf einem Mailserver kann immer nur ein Sieve-Script aktiv sein: Hat jemand Filter in **SOGo** angelegt, bindet die Webmail diese ein („Bestehende Filter aus „sogo“ weiter ausführen“), sodass sie weiterlaufen. Werden die Filter später wieder in SOGo gespeichert, aktiviert SOGo sein eigenes Script – dann in der Webmail einmal erneut speichern. Abwesenheitsnotiz bitte nur an einer Stelle (Webmail *oder* SOGo) einschalten.

## Schutz vor Passwort-Raten

Fehlgeschlagene Anmeldungen (Login, Kalender/Kontakte-Zugriff, „Passwort ändern“) werden gezählt:

| Regel | Standard | Wirkung |
|---|---|---|
| gleiches Konto von derselben Adresse | 5 Fehlversuche (`LOGIN_MAX_PER_ACCOUNT`) | diese Adresse für dieses Konto 15 Min. gesperrt |
| beliebige Konten von derselben Adresse | 20 Fehlversuche (`LOGIN_MAX_PER_IP`) | Adresse 60 Min. gesperrt |
| gleiches Konto von vielen Adressen | ab 30 pro Stunde | nur gebremst – keine Sperre, damit niemand Benutzer aussperren kann |

Jede falsche Eingabe wird zusätzlich ~1 s verzögert. Netze in `LOGIN_WHITELIST` werden nie gesperrt. Unter **Benutzer → Sicherheit** sieht der Admin aktive Sperren und die letzten Fehlversuche und kann Sperren aufheben. Fehlversuche stehen im Log als `[login] Fehlversuch (login) für "name@domain" von 1.2.3.4` (für eigenes fail2ban verwendbar).

**Wichtig hinter Nginx**: `TRUST_PROXY=true` muss gesetzt sein, sonst sieht die Webmail für alle Benutzer die Adresse des Proxys (die Seite *Sicherheit* warnt dann).

**Wichtig mit mailcow**: mailcow sperrt Adressen mit vielen fehlgeschlagenen IMAP-Anmeldungen (Netfilter/Fail2ban). Die Webmail meldet sich immer von *ihrer* Adresse an – vertippen sich mehrere Benutzer, könnte mailcow die ganze Webmail sperren. Deshalb die IP des Webmail-Servers im mailcow-Adminbereich bei den **Fail2ban-Parametern** (unter *System → Konfiguration*) in die **Whitelist** eintragen. Den Schutz vor Raten übernimmt dann die Webmail (mit der echten Adresse des Besuchers).

## Kalender & Kontakte

Webmail bringt keinen eigenen CalDAV/CardDAV-Server mit. Unter **Einstellungen → Kalender & Kontakte** bindet jeder Benutzer seinen vorhandenen Server ein; Kalender und Adressbücher werden automatisch gefunden. Beispiel-URLs:

| Server | URL |
|---|---|
| Nextcloud | `https://cloud.example.com/remote.php/dav` |
| mailcow / SOGo | `https://mail.example.com/SOGo/dav` |
| Radicale, Baïkal | Basis-URL des Servers |
| mailbox.org | `https://dav.mailbox.org` |
| iCloud | `https://caldav.icloud.com` (App-Passwort) |

Die Daten bleiben auf dem Server und sind weiterhin mit Handy, Thunderbird usw. synchron.

### Serientermine

Im Termin-Dialog unter **Wiederholung**: täglich, wöchentlich (mit Wochentagen), monatlich oder jährlich, jeweils „alle n Tage/Wochen/…“, endet nie, an einem Datum oder nach einer Anzahl Terminen. Beim Ändern oder Löschen eines Termins aus einer Serie fragt die Webmail: **Nur diesen Termin** (Ausnahme bzw. Löschung nur dieses Datums) oder **Alle Termine der Serie** (eine geänderte Uhrzeit verschiebt die ganze Serie). Erweiterte Regeln aus anderen Programmen (z. B. „jeden 2. Dienstag im Monat“) werden angezeigt und bleiben erhalten, solange die Wiederholung nicht geändert wird.

### Einladungen beantworten

Die Webmail erstellt selbst keine Einladungen, beantwortet aber empfangene:

- Eine Einladungsmail zeigt eine Karte mit Zeit, Ort, Organisator und Teilnehmern sowie den Knöpfen **Zusagen / Vielleicht / Absagen**. Die Antwort geht als Standard-Kalendermail (iMIP) an den Organisator; der Termin wird im gewählten Kalender eingetragen (bei Absage entfernt). Das Senden der Antwort lässt sich abwählen.
- Im Kalender sind unbeantwortete Einladungen gestrichelt, vorläufig zugesagte schraffiert. Im Termin-Dialog lässt sich die Antwort nachträglich ändern; beim Löschen einer Einladung kann eine Absage an den Organisator gehen.
- **Absagen des Organisators** lassen sich mit einem Klick aus dem Kalender entfernen. Antworten auf Einladungen, die du z. B. in SOGo oder auf dem Handy verschickt haben, werden beim Öffnen der Antwortmail in den Termin übernommen.
- Teilnehmer von Terminen aus anderen Programmen werden im Dialog mit ihrem Status angezeigt und beim Bearbeiten nicht verändert.

**SOGo/mailcow**: Eingetragene Einladungen erhalten `SCHEDULE-AGENT=CLIENT` (RFC 6638), damit SOGo nicht zusätzlich eine eigene Antwort verschickt (ab SOGo 3.2.5).

### Lokale Adressbücher, Import/Export, Adressen aus Mails

- **Lokale Adressbücher**: In *Kontakte → +* als Speicherort „Lokal – nur in der Webmail“ wählen. Sie liegen in der Datenbank der Webmail (pro Benutzer) und funktionieren wie Server-Adressbücher (Kontakte, Fotos, Adressvorschläge, Bilder von Kontakten anzeigen), werden aber nicht mit Handy/Thunderbird abgeglichen. Gesichert werden sie mit dem Datenbank-Backup.
- **Export/Import**: Im Menü eines Adressbuchs (⋯) als `.vcf` exportieren bzw. eine `.vcf`-Datei importieren – z. B. um Kontakte zwischen lokalen und Server-Adressbüchern zu verschieben. Gleiche Kontakte (gleiche UID) werden beim erneuten Import aktualisiert statt verdoppelt.
- **Adressen aus Mails übernehmen**: In einer geöffneten Mail auf Absender oder Empfänger klicken → „Zu Kontakten hinzufügen…“ (Name und Adresse vorausgefüllt, Adressbuch wählbar). Ausserdem: „Neue E-Mail an …“ und „Adresse kopieren“.
- Neue Adressbücher und Kalender auf dem Server erhalten einen lesbaren Pfad (z. B. `…/familie/`) und den gewählten Namen – auch bei SOGo, das den Namen beim Anlegen sonst nicht übernimmt.

## Konfiguration (`.env`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `POSTGRES_PASSWORD` | – | DB-Passwort (Pflicht) |
| `SECRET_KEY` | – | Schlüssel für gespeicherte Passwörter (Pflicht, **nie ändern**, sonst müssen alle Konto-Passwörter neu eingegeben werden) |
| `AUTH_MODE` | local | `imap` = Login mit den Zugangsdaten des Mailservers |
| `AUTH_IMAP_HOST` / `_PORT` / `_SECURITY` | – / 993 / ssl | Nur noch für die **Ersteinrichtung**: daraus wird beim ersten Start die Standard-Domain `*` erzeugt (danach unter „Domains & Mailserver“ pflegen) |
| `AUTH_SMTP_HOST` / `_PORT` / `_SECURITY` | wie IMAP / 465 / ssl | dito, für den Postausgang |
| `AUTH_ALLOW_INSECURE_TLS` | false | Selbstsigniertes Zertifikat am Mailserver akzeptieren |
| `AUTH_DEFAULT_DOMAIN` | – | Wird an Logins ohne `@` angehängt |
| `AUTH_ADMINS` | – | Kommagetrennte Logins mit Admin-Rechten |
| `AUTH_CREATE_ACCOUNT` | true | Postfach beim ersten Login als Konto einrichten |
| `LOGIN_MAX_PER_ACCOUNT` / `LOGIN_MAX_PER_IP` / `LOGIN_WHITELIST` | 5 / 20 / – | Schutz vor Passwort-Raten (siehe oben) |
| `QUOTA_WARN_PERCENT` / `QUOTA_FULL_PERCENT` | 80 / 95 | Speicherplatz-Balken: ab diesem Füllstand orange bzw. rot (Ordnerleiste, Kontoeinstellungen, Benutzerübersicht) |
| `AUTH_DAV_URL` / `AUTH_DAV_NAME` | – / Kalender & Kontakte | CalDAV/CardDAV-Server, der beim IMAP-Login mit denselben Zugangsdaten eingebunden wird |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | admin / zufällig | Lokaler Administrator beim allerersten Start (bei `AUTH_MODE=imap` nur, wenn ein Passwort gesetzt ist) |
| `PUBLIC_URL` | – | Öffentliche Adresse, z. B. `https://mail.example.com` (für den Link in der Zurücksetzen-Mail) |
| `PASSWORD_MIN_LENGTH` / `PASSWORD_RESET_MINUTES` | 8 / 30 | Mindestlänge neuer Passwörter / Gültigkeit des Links |
| `PASSWORD_HELP_TEXT` | – | Hinweistext bei „Passwort vergessen?“, wenn kein automatischer Ablauf eingerichtet ist |
| `LDAP_URL`, `LDAP_STARTTLS`, `LDAP_TLS_INSECURE` | – | LDAP-Server (ldaps:// empfohlen) |
| `LDAP_BIND_DN` / `LDAP_BIND_PASSWORD` | – | Dienstkonto zum Suchen und Zurücksetzen |
| `LDAP_BASE_DN` / `LDAP_USER_FILTER` | – / `(\|(uid={user})(mail={user}))` | Benutzersuche; Platzhalter `{user}`, `{localpart}`, `{domain}` |
| `LDAP_USER_DN_TEMPLATE` | – | Alternativ fester DN, z. B. `uid={localpart},ou=people,dc=example,dc=com` |
| `LDAP_RECOVERY_ATTRS` / `LDAP_RECOVERY_FALLBACK_PRIMARY` | mailAlternateAddress / false | Attribut(e) der Ersatz-Adresse; ggf. Rückfall auf `LDAP_MAIL_ATTR` |
| `LDAP_PASSWORD_METHOD` | exop | `exop` (RFC 3062), `ssha`, `plain` oder `ad` (Active Directory, nur LDAPS) |
| `SYSTEM_SMTP_*`, `SYSTEM_MAIL_FROM` | – | SMTP für Systemmails (Passwort vergessen) |
| `HTTP_BIND` / `HTTP_PORT` | 127.0.0.1 / 8080 | Wo die App lauscht. `0.0.0.0` für Zugriff aus dem LAN |
| `SESSION_DAYS` | 30 | „Angemeldet bleiben“: Sitzung bleibt so viele Tage nach der letzten Nutzung gültig (wird bei Nutzung verlängert) |
| `SESSION_IDLE_HOURS` | 12 | Ohne „Angemeldet bleiben“: Sitzung endet mit dem Browser bzw. nach so vielen Stunden Inaktivität |
| `COOKIE_SECURE`, `TRUST_PROXY` | true | Für Betrieb hinter Nginx mit HTTPS. Nur für Tests ohne HTTPS auf `false` setzen (sonst klappt der Login nicht) |
| `ALLOW_REGISTRATION` | false | Selbstregistrierung erlauben |
| `SYNC_INITIAL_MESSAGES` | 1000 | Nachrichten pro Ordner beim Erst-Sync |
| `POLL_INTERVAL_SECONDS` | 120 | Abfrageintervall für Ordner ohne IDLE |

## Betrieb

- **Komprimierung**: Die Webmail komprimiert selbst (Brotli/gzip) – die Oberfläche wird beim Start einmal vorkomprimiert (≈ 390 KB → 100 KB), API-Antworten ab 1 KB beim Senden. Ein vorgeschalteter Proxy muss nichts weiter tun; das Nginx-Beispiel enthält zusätzlich gzip für den Rest.

- **Backup**: Volume `webmail_db-data` (Benutzer, Konten, Einstellungen). Mails, Kalender und Kontakte liegen auf den jeweiligen Servern.
  `docker compose exec db pg_dump -U webmail webmail > backup.sql`
- **Update**: `docker compose pull && docker compose up -d --build`
- **Logs**: `docker compose logs -f app`
- **Browser-Cache**: Die Oberfläche wird unter `/v/<kennung>/…` ausgeliefert; die Kennung ändert sich bei jedem Update automatisch. Browser – auch auf dem Handy – laden nach einem Update daher sofort die neuen Dateien, ohne Cache leeren.
- Der Nachrichtenindex ist ein Cache – bei Problemen mit einem Konto: Konto speichern (verbindet neu) oder Server-Einstellungen ändern (Index wird neu aufgebaut).

## Bekannte Grenzen

- **Keine OAuth2-Anmeldung.** Gmail, iCloud, Yahoo, Fastmail brauchen ein App-Passwort; Microsoft-Konten (Outlook.com/Microsoft 365) erlauben Passwort-Login teils gar nicht mehr.
- Push per IDLE nur für den Posteingang jedes Kontos (IMAP erlaubt pro Verbindung nur einen Ordner); andere Ordner werden im Intervall abgefragt und sofort beim Öffnen synchronisiert.
- Suche durchsucht den lokalen Index (Betreff, Absender, Empfänger, Vorschau), keine Volltextsuche im Mailtext.
- Einladungen werden nur beantwortet, nicht erstellt (Teilnehmer einladen bitte in SOGo oder einem anderen Kalenderprogramm).

## Projektstruktur

```
docker-compose.yml      Stack (db, app)
nginx/webmail.conf      Beispiel-Konfiguration für Nginx
app/src/server.js       Einstieg, Express, WebSocket
app/src/auth.js         Sessions, Login, Benutzerverwaltung
app/src/imap-auth.js    Anmeldung mit IMAP-Zugangsdaten, automatische Einrichtung
app/src/ldap.js         Passwort ändern/zurücksetzen im LDAP
app/src/password.js     „Passwort vergessen“-Ablauf
app/src/imap/           Sync-Worker (IDLE, CONDSTORE), Threading, Manager
app/src/mail/           API für Konten, Identitäten, Ordner, Threads, Aktionen, Versand
app/src/dav/            CalDAV/CardDAV-Client, Kalender-/Kontakt-API, vCard/iCal, Einladungen beantworten
app/src/sieve/          ManageSieve-Client, Sieve-Script für Filter & Abwesenheit
app/src/loginguard.js   Schutz vor Passwort-Raten
app/public/             Frontend (Vanilla-JS-Module, kein Build-Schritt)
```
