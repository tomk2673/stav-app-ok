# PUB INVOICES v1

Mobilní PWA pro:

- OCR fotografií a PDF faktur, kontrolu položek a naskladnění,
- rychlé uložení více dokladů do fronty a následné schválení vedoucím,
- denní uzávěrky s kontrolou OCR a zamknutím po finalizaci,
- auditované skladové pohyby a neměnné zaúčtované doklady,
- vratné obaly a spotřební materiál vedené v kusech,
- váhovou inventuru lahví s tárou, koeficientem ml/g a teplotní korekcí,
- role majitel, vedoucí, zaměstnanec, účetní a servis.

## Spuštění

Z kořene repozitáře:

```bash
python3 -m http.server 8080
```

Pak otevři `http://localhost:8080/pub_guru/start.html`. Kamera na telefonu vyžaduje HTTPS; testovací nasazení proto používá GitHub Pages.

Automatická kontrola a nasazení jsou v `.github/workflows/pub-guru-pages.yml`. Pull request spouští syntaktické, jednotkové a kontraktové testy. Nasazení proběhne pouze z `main` nebo ručně přes `workflow_dispatch`.

## Backend a bezpečnost

Prohlížeč používá pouze veřejný Supabase publishable key z `app-config.js`. Privilegovaný `service_role` klíč do klienta nepatří.

Databázové změny jsou v `database/`. Produkční tabulky mají RLS a explicitní oprávnění. Zaúčtované faktury, uzavřené inventury, finalizované uzávěrky a skladový ledger se nepřepisují. Oprava probíhá novým auditovaným záznamem.

Kusové položky ukládají jednotky odděleně od mililitrů. Záporný pohyb se na databázi omezí na evidovaný zůstatek; neaplikovaný zbytek zůstane uložen jako `untracked_units`, takže se stav nedostane pod nulu a původní požadavek nezmizí.

## Ověření

```bash
for f in pub_guru/*.js; do node --check "$f"; done
node --test tests/*.test.js
```

OCR je pomocník, ne účetní autopilot. Každou rozpoznanou položku a finanční hodnotu musí před zaúčtováním potvrdit oprávněný uživatel.

## Fronta faktur

Focení, dávkový výběr a import alba ukládají původní doklady do soukromého úložiště. Stránka Faktury automaticky zpracovává i dříve uložené úlohy pomocí místního OCR, bez placeného API. Pro zpracování musí zůstat otevřená; po návratu pokračuje. Serverové AI čtení jednotlivého dokladu je volitelné.

Před nasazením webu aplikuj `database/20261010033954_invoice_capture_queue_worker.sql`. RPC převzetí s tokenem a obnovovanou desetiminutovou rezervací brání souběžnému čtení stejné úlohy. Faktura, její řádky, audit a stav fronty se ukládají v jedné transakci. Rozpoznaná data mají stav `review`; fronta sama nic nenaskladňuje. Otisk se bere z původního souboru před kompresí. Chybějící datum nebo částka zůstávají nevyplněné. Chyba jedné úlohy nezablokuje další; tlačítko „Zkusit znovu“ zachová uložený zdroj.

Regrese fronty, jejího uživatelského toku a databázových přístupů jsou v `tests/pos-web` a spouštějí se pomocí `npm test --prefix tests/pos-web`.

## Kontrola načtených částek

Množství `1,000` a `1.000` znamená jeden kus; desetinná čísla a záporné vratky zůstávají zachované. Částka k úhradě má přednost před ostatními součty. Spotřební daň, základ daně a samostatný součet DPH se nikdy nepoužijí jako konečná cena. Rozporné celkové částky zůstanou nevyplněné.

Neznámá sazba DPH zůstává nevybraná. Pokud z OCR není jasné, zda jednotková cena obsahuje DPH, zobrazí se jen jako nepřepočtená OCR cena s upozorněním. Schválení vyžaduje dodavatele, číslo a datum dokladu, vyplněné schvalované řádky a shodu jejich finančního součtu s fakturou. Započítávají se také ignorované obaly a služby; jejich částky zůstávají uložené bez naskladnění. Tolerance je nejvýše 1 Kč, případně 0,02 Kč na řádek u dokladů nad 50 řádků. Kontrola probíhá před prvním zápisem produktů, cen, historie nebo schválení.
