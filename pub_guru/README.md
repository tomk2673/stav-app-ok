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

Následně aplikuj `database/20261010141443_invoice_approval_queue_completion.sql` před aktualizací webu. Schvalování nejprve uloží mezistav `approved`; audit `invoice.posted` potom atomicky zaúčtuje sklad, změní fakturu na `posted` a dokončí její úlohu jako `done`. Selhání kteréhokoli z těchto kroků vrátí celou poslední transakci a úloha zůstane ke kontrole. Dokončení fronty má vlastní audit a neuděluje uživatelům přímé právo měnit úlohy. Samotná migrace nepřepisuje existující finanční ani skladová data.

Starší úlohy s již zaúčtovanou fakturou souhrn zobrazí jako dokončené bez zpětného zápisu. Počty a seznam používají stejný odvozený stav, vždy pro stejnou organizaci a provozovnu. Samotné `approved` se jako dokončené nepočítá. Schvalování po ztracené odpovědi ověří uložený stav; již zaúčtovaný doklad znovu nemění. Ověření před nasazením probíhá pouze v oddělené testovací databázi; fyzický iPhone a reálné dodavatelské faktury tím nejsou ověřené.

Regrese fronty, jejího uživatelského toku a databázových přístupů jsou v `tests/pos-web` a spouštějí se pomocí `npm test --prefix tests/pos-web`.
