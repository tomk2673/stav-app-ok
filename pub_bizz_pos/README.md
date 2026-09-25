# PUB-BIZZ POS 1.0

Nouzová dotyková pokladna pro jeden prohlížeč / jedno zařízení. Samostatný modul v repozitáři PUB GURU. Bez externích runtime závislostí, analytiky či odesílání tržeb třetím stranám.

## Spuštění

`python3 -m http.server 8080` v této složce, pak `http://localhost:8080/`. Pro produkci nasadit obsah složky na Vercel (framework Other, bez buildu). Používat stabilní produkční doménu. Každý jiný origin má vlastní data.

1. Ceník obsahuje 208 položek s číselnou cenou dodaných uživatelem 25. 9. 2026. Všech 30 položek bez ceny (včetně Kolek) je na výslovný pokyn vynecháno z pokladny. Čísla Agnisu jsou zachována. Cuba libre #4328 a #4336 stojí na výslovný pokyn uživatele 130 Kč. Nejasné zápisy objemů v názvech jsou převzaty bez odhadu; nejsou použity pro odpis skladu. Doplnit chybějící ceny podle skutečnosti. Hromadné vložení používá řádky `název; cena; kategorie; porce; sazba DPH`.
2. Nastavení: vyplnit provozovatele a jeho skutečný režim DPH. Neznámý režim je na výtisku označen jako provozní záznam. Při plátci je sazba na prodeji povinná.
3. Otevřít směnu se skutečnou počáteční hotovostí. Markovat na rychlý nebo pojmenovaný účet.
4. Uhradit celý účet nebo vybrané kusy. Kartu obsluhovat na samostatném terminálu a potvrdit až po úspěchu.
5. Zaplatit otevřené účty, spočítat hotovost, uzavřít směnu a stáhnout JSON zálohu.

## Data a integrita

Samostatný soubor `PUB-BIZZ-pokladna-offline.html` vzniká příkazem `python3 build-standalone.py` a obsahuje stejný kód i ceník bez síťových závislostí. Otevřít na PC v běžném okně Chrome / Edge a ponechat na stejném místě. Používá vlastní místní úložiště podle původu stránky; před přechodem na web stáhnout a obnovit JSON zálohu. Nezprovozňovat současně soubor a web jako dvě nezávislé pokladny pro stejné účty.

- IndexedDB: načtení aktuálního stavu, ověření, zapsání účtu + platby + historie v jedné readwrite transakci. UI potvrzuje až `oncomplete`. Po chybě transakce nezůstává částečně uložená platba.
- Platby používají jedinečný operationId, kontrolu revize účtu a cenu zachycenou v položce. Idempotentní opakování nezdvojí tržbu. Souběžné transakce se serializují; druhá změněná revize se odmítne.
- Peníze jsou celá čísla v haléřích. Hotovostní platba zaokrouhlena na Kč, karta přesně, kombinace obsahuje celé Kč hotově a přesný zbytek kartou. Rozdíl zaokrouhlení je samostatný údaj.
- Vratka má samostatný záporný doklad, je možná jednou a pouze v otevřené směně původního prodeje. Platba na terminálu ani vrácení peněz nejsou automatické.
- Doklady a uzavřené směny nelze v UI přepsat. Místní historii nelze vydávat za bezpečnostně nezměnitelný serverový audit.
- Service worker uloží shell po prvním úspěšném online načtení. Data IndexedDB při nové verzi nemaže. Aktualizace čeká na zavření starých oken, neobnovuje pokladnu uprostřed práce.
- Záloha používá SHA-256 pro kontrolu poškození, nikoliv ověření autora. Obnova je povolena jen do prázdné pokladny bez aktivní směny. Soubor před obnovou prochází kontrolou formátu a součtů. Po migraci nesmí současně běžet stará kopie.
- Data nemají cloudovou kopii. Smazání dat prohlížeče nebo ztráta zařízení bez zálohy je ztratí. Neprovozovat v soukromém okně. Uložení zálohy vyžaduje dokončení stažení uživatelem.

## Budoucí PUB-BIZZ propojení

Záloha `pubbizz.pos.backup.v1` obsahuje stabilní venueId, deviceId, productId, orderId, receiptId, operationId, shiftId, snapshot cen / DPH a chronologické auditní události. Produkt/řádek má stockProductId pro budoucí mapování skladu. Automatická synchronizace, cloudová autorizace a odpis skladu nejsou součástí tohoto vydání. Před více zařízeními zavést serverovou idempotenci a tenant-scoped autentizaci. Databázová migrace pro PUB GURU se v tomto vydání neprovádí.

## Ověření

Z kořene repozitáře: `node --test tests/pub-bizz-pos.test.js`. Browser acceptance: otevření směny, ceny, účet, částečná a karetní platba, odmítnutí nedoplatku, obnova po reloadu, vratka, uzávěrka, záloha a offline reload. Tisk přes browser ověřit na konkrétním ovladači tiskárny podniku.
