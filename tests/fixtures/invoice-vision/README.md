# České fiktivní faktury

Pět obrázků a očekávané hodnoty v `cases.cjs` jsou výhradně syntetická data. Neobsahují skutečného dodavatele, zákazníka, doklad ani platbu.

- `mixed-vat.png`: 5.812,- Kč, DPH 21/12/0 %, kód s počátečními nulami, vratný obal, bonus.
- `discount-advance.png`: deset kusů, vytištěná sleva 10 % / 100 Kč bez DPH, cena faktury 1 089 Kč, záloha 500 Kč, zbývá 589 Kč.
- `quantity-units.png`: 1.000 ks = jeden kus; 1,500 l a karton nesmějí automaticky vyrobit skladové kusy.
- `credit-note.png`: dvě vrácené lahve, záporné množství i částky.
- `unreadable.png`: chybějící množství musí zůstat `null`, i když jej lze z ostatních čísel dopočítat.

`invoice-fictional.test.cjs` simuluje strukturovaný výstup poskytovatele a ověřuje pouze účetní kontroly. Nepotvrzuje přesnost OCR. API testy rovněž používají simulovaný OpenAI klient.

Obrázky lze obnovit: `node tests/fixtures/invoice-vision/render.cjs` po instalaci prohlížečových závislostí. Skutečné čtení používá přesně produkční prompt a JSON schéma:

```sh
node tests/fixtures/invoice-vision/live.cjs --live
```

Příkaz vyžaduje již bezpečně připojený `OPENAI_API_KEY` a provede nejvýše pět placených požadavků bez automatického opakování. Nepředávej klíč jako argument příkazu ani jej nevkládej do chatu. Bez klíče skončí s `NOT_RUN` a kódem 2; nejde o úspěšný test. Výsledný `live-results.json` je ignorovaný Gitem. Výpis neobsahuje klíč, hlavičky, doklady ani surové chyby SDK. Ani úspěch této malé syntetické sady není důkaz bezchybného čtení všech skutečných fotografií.
