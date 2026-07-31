# WetterGarten 21

Kostenlose, installierbare Open-Source-Wetter-PWA in neomorphem Design.

## Funktionen

- Wetter aktuell und stündlich
- Antippbare Tageskarten mit vollständigem 24-Stunden-Verlauf für Tag 1–16
- Bis zu 12 lokal gespeicherte Ortsfavoriten
- 16-Tage-Modellvorhersage plus Ensemble-Trend für Tag 17–21
- Animiertes Regenradar
- Pollenflug-Analyse für Erle, Birke, Gräser, Beifuß, Ambrosia und Olive
- Aussaat-, Vorkultur- und Erntekalender mit Wetterhinweisen
- Bauernregel passend zu Datum oder Wetterlage
- Standortsuche, GPS, Hell-/Dunkelmodus
- Offline-App-Shell und zuletzt gespeicherte Wetterdaten
- Keine Werbung, keine In-App-Käufe, kein Benutzerkonto

## Starten

Die App sollte über einen kleinen lokalen Webserver oder HTTPS betrieben werden, damit PWA, GPS und Service Worker funktionieren.

### Einfach mit Python

```bash
python -m http.server 8080
```

Danach im Browser öffnen:

```text
http://localhost:8080
```

### GitHub Pages

Den gesamten Inhalt dieses Ordners in ein GitHub-Repository hochladen und GitHub Pages für den Hauptbranch aktivieren.

## Datenquellen

- Open-Meteo Forecast API
- Open-Meteo Ensemble Mean API
- Open-Meteo Air Quality API / CAMS
- RainViewer Weather Maps API
- OpenStreetMap

Die App ist für private beziehungsweise nicht-kommerzielle Nutzung vorkonfiguriert. Vor einer kommerziellen Veröffentlichung müssen die jeweils aktuellen Nutzungs- und Lizenzbedingungen der Datenanbieter geprüft werden.

## Wichtige Hinweise

- Tag 17–21 wird als Langfristtrend dargestellt, nicht als präzise Tages- oder Stundenprognose.
- Pollenwerte sind modellierte Konzentrationen und kein medizinischer Rat.
- Bauernregeln sind traditionelles Kulturgut und keine wissenschaftlichen Vorhersagen.
- Der Gartenkalender ist eine Orientierung für das mitteleuropäische Klima.

## Lizenz

MIT für den App-Quellcode. Daten und Karten unterliegen den Bedingungen der jeweiligen Anbieter.
