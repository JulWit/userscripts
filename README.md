# Steam-Wunschliste – Deal-Score

UserScript für die Steam-Wunschliste (`https://store.steampowered.com/wishlist/*`), den Einkaufswagen
(`https://store.steampowered.com/cart/`) und die Store-Seite eines Spiels (`https://store.steampowered.com/app/*`).
Es zeigt vor jedem Spieltitel ein farbiges Badge mit einem
**Deal-Score von 1 bis 100**: Rot (≤ 30) über Gelb/Orange (≈ 55) bis Grün (≥ 80).
Der Score ist umso höher, je besser die Rezensionen, je höher der Rabatt und je niedriger der Preis. Die Beliebtheit
fließt als Bonus ein.

## Installation (Firefox + Violentmonkey)

1. [Violentmonkey](https://addons.mozilla.org/firefox/addon/violentmonkey/) installieren (Tampermonkey geht auch).
2. **[Skript installieren](https://raw.githubusercontent.com/JulWit/userscripts/main/steam-dealscore.user.js)**
   anklicken und im Violentmonkey-Dialog bestätigen.
3. Die eigene Wunschliste öffnen, z. B. `https://store.steampowered.com/wishlist/profiles/<steamid>/`, oder den
   Einkaufswagen oder die Store-Seite eines Spiels.

**Updates** kommen automatisch: Violentmonkey prüft regelmäßig, ob auf GitHub eine neue Version liegt. Sofort geht es
über das Dashboard → **Nach Updates suchen**. Eine früher von Hand eingefügte Version vorher löschen, sonst fehlt ihr
die Update-URL. Die Einstellungen bleiben dabei erhalten.

## Bedienung

- **Badge:** Mit der Maus über das Badge fahren, dann zeigt ein Tooltip die Aufschlüsselung je Komponente
  (Rohwert → Punkte 0–100 · Gewicht).
  - `…`: Zusatzdaten werden noch geladen.
  - `–` (grau): kein Preis (unveröffentlicht oder nicht kaufbar).
  - Gestrichelter Rand: keine Rezensionsdaten, der Score beruht nur auf Rabatt und Preis.
- **Einstellungen:** Violentmonkey-Symbol → **Deal-Score: Einstellungen …** (gelten für alle Seiten)
  - Gewichte für Gesamtbewertung, Letzte 30 Tage, Rabatt, Preis und Beliebtheit. Sie werden automatisch normiert,
    die Summe muss also nicht 100 sein.
  - Referenzpreis: Bei diesem Endpreis ergibt die Preis-Komponente 50 Punkte.
  - **Zusatzdaten laden:** Das Histogramm ist die einzige Quelle für Rezensionen. Aus bedeutet keine
    Netzwerkanfragen. Der Score beruht dann auf allen Seiten nur auf Rabatt und Preis.
  - **Qualitäts-Malus** an/aus.
  - **Standard wiederherstellen** trägt die Standardwerte ins Formular ein, übernommen werden sie erst mit **Speichern**.
  - **Cache leeren** löscht die zwischengespeicherten Histogrammdaten.
- Weitere Standardwerte (K, Farbstopps, Cache-Dauer, Parallelität) stehen im `CONFIG`-Objekt am Skriptanfang.
- Debug-Ausgabe (`console.table` der gelesenen Einträge): `debug: true` in `CONFIG` setzen.

## Score-Formel

Alle Komponenten liegen zwischen 0 und 1.

| Komponente | Berechnung |
|---|---|
| Gesamtbewertung `R_G` | `ratingG = p − (p − 0,5) · 2^(−log10(n + 1))` (SteamDB-Formel: wenige Rezensionen ziehen Richtung 50 %), dann `R_G = (ratingG − 0,5) / 0,5`, begrenzt auf 0…1 |
| Letzte 30 Tage `R_30` | `p30 = (up30 + 50 · ratingG) / (n30 + 50)`, dann wie oben skaliert |
| Rabatt `D` | `1 − (1 − Rabatt % / 100)²` |
| Preis `P` | `1 / (1 + (Endpreis / Referenzpreis)²)`: 20 € → 0,5, kostenlos → 1 |
| Beliebtheit `B` | `log10(Rezensionen gesamt + 1) / 5`: 100.000 Rezensionen → 1 |

`p`, `n`, `up30` und `n30` stammen alle aus dem Histogramm. Ohne Histogramm entfallen `R_G`, `R_30`, `B` und der
Qualitäts-Malus; die Gewichte von Rabatt und Preis werden dann normiert.

Rabatt und Preis sind bewusst großzügig skaliert: 70 % Rabatt und Preise unter 5 € gelten als sehr gut. Die
Rezensionen bleiben linear, damit sich gute Spiele noch unterscheiden und der Qualitäts-Malus wirkt.

| Rabatt | Punkte | | Preis | Punkte | | positive Rezensionen¹ | Punkte |
|---|---|---|---|---|---|---|---|
| 20 % | 36 | | 40 € | 20 | | 60 % | 20 |
| 30 % | 51 | | 20 € | 50 | | 70 % | 40 |
| 50 % | 75 | | 10 € | 80 | | 80 % | 60 |
| 70 % | 91 | | 5 € | 94 | | 90 % | 80 |
| 90 % | 99 | | 2,69 € | 98 | | 95 % | 90 |

¹ bei vielen Rezensionen; bei wenigen zieht die SteamDB-Formel den Wert etwas Richtung 50 %.

Die Exponenten stehen in `CONFIG`: `discountCurve: 2`, `priceExponent: 2`, `reviewCurve: 1`. Der Wert 1 ergibt
jeweils eine lineare Skala, höhere Werte eine großzügigere.

```
S     = Σ(Gewicht · Wert) / Σ(Gewicht)        nur über verfügbare Komponenten
R     = (w_G · R_G + w_30 · R_30) / (w_G + w_30)
S     = S · min(1, 0,5 + R)                   Qualitäts-Malus: hoher Rabatt macht schlechte Spiele nicht grün
Score = round(1 + 99 · S)
```

Standardgewichte: Gesamtbewertung 25, Letzte 30 Tage 15, Rabatt 30, Preis 20, Beliebtheit 10.

## Datenquellen

Auf Wunschliste, Einkaufswagen und Store-Seite gilt **dieselbe Berechnung mit denselben Quellen**. Dasselbe Spiel
zum selben Preis bekommt deshalb überall denselben Score.

- **Rabatt und Preise** liest das Skript bei jeder Anzeige frisch von der Seite.
- **Rezensionen** (Gesamtbewertung, letzte 30 Tage, Beliebtheit) kommen ausschließlich aus
  `/appreviewhistogram/<appid>`, also aus allen Sprachen. Rezensionsangaben auf der Seite (etwa „Rezensionen
  (Deutsch)“ auf der Wunschliste) werden nicht verwendet. Die Anfragen sind same-origin, laufen höchstens zu dritt
  parallel und werden 24 h gecacht.
- **Ohne Histogramm** (Zusatzdaten aus oder Abruf fehlgeschlagen) zählen auf allen Seiten nur Rabatt und Preis. Das
  Badge bekommt dann einen gestrichelten Rand.
- **Bundles und Pakete im Wagen:** Die Rezensionen aller dort aufgeführten Titel werden zusammengezählt, sodass
  Titel mit vielen Rezensionen stärker zählen. Rabatt und Preis gelten für das Bundle als Ganzes.
- **Store-Seite:** Das Badge am Spieltitel bewertet das erste Kaufangebot (meist die Standard-Edition). Gibt es
  mehrere Editionen, bekommt jede Kaufbox ein eigenes Badge. Bundle-Kaufboxen bleiben ohne Badge, weil ihr Inhalt
  nicht auf der Seite steht.

## Offline-Test

`test/` enthält Harnesses für beide Seiten (aus `example-wishlist.html` und `example-cart.html`) mit einem GM-Shim:

```bash
powershell -ExecutionPolicy Bypass -File test/build-harness.ps1
```

```bash
powershell -ExecutionPolicy Bypass -File test/serve.ps1
```

Danach `http://localhost:8765/wishlist/` bzw. `http://localhost:8765/cart/` öffnen. Der Server liefert die
Harnesses unter den echten Pfaden aus, damit das Skript die Seite erkennt. Die Histogramm-Anfragen schlagen offline
fehl, deshalb zählen dort nur Rabatt und Preis (z. B. RimWorld 37) und alle Badges sind gestrichelt.
