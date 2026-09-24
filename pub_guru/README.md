# PUB GURU v1

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
