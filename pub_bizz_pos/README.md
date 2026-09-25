# PUB-BIZZ POS 2.0 — společná pokladna PUB GURU

Pokladna, faktury, sklad, inventury a uzávěrky jsou ve stejném repozitáři `tomk2673/stav-app-ok` a ve stávajícím projektu PUB GURU `gnfqlfxuagcgjztaueot`. Online pokladna sdílí účty mezi PC a telefonem; bez potvrzení serveru nezobrazuje operaci jako uloženou.

## Použití

1. V PUB GURU otevřít **Pokladna**, případně cestu `/pokladna` na společné doméně. Přihlášení je stejným účtem PUB GURU; na stejné doméně se existující relace sdílí. Při více provozovnách je nutný výběr.
2. Ceník obsahuje **208 položek s číselnou cenou**. Všech 30 položek bez ceny, včetně „Kolek“, je na pokyn vynecháno. Kódy Agnisu zůstaly. Cuba libre #4328 i #4336 stojí **130 Kč**. Nejasné objemy v názvech nejsou automaticky převáděné na receptury.
3. V **Nastavení** doplnit provozovatele a skutečný režim DPH. Sazby DPH nejsou odhadnuté. U plátce je sazba povinná před markováním položky.
4. V části **Sklad** přiřadit každé prodávané položce skutečné suroviny a množství na jednu porci: například 40 ml destilátu; koktejl může mít více surovin. Žádná receptura není bez potvrzení uživatele předvyplněná do produkčních dat. K dispozici je 68 stávajících skladových položek. Službu lze výslovně označit „bez odpisu“ s důvodem.
5. Otevřít směnu, markovat na rychlý nebo pojmenovaný účet. Účty se obnovují každé 3 sekundy. Na telefonu je dole rychlé tlačítko k aktuálnímu účtu.
6. Otevření platby rezervuje účet. Kartu zpracovat na samostatném terminálu a potom potvrdit. Po zavření dialogu zůstane rezervace, dokud obsluha zkontroluje stav platby a dokončí ji nebo účet uvolní. Terminál ani tiskárna nejsou přímo ovládané z webu.
7. Prodej bez receptury zůstává v seznamu chybějících odpisů. Po nastavení receptury lze jednou provést odpis k původnímu prodeji. Inventura vidí počet čekajících odpisů.
8. Vratka peněz automaticky nevrací spotřebované nápoje na sklad. Fyzicky vrácené zboží vyžaduje zaškrtnutí volby. Vrací se pouze skutečně odepsané množství, včetně kusových položek s nedostatkem zásob.
9. Uzavřená směna vytvoří záznam v **Uzávěrkách PUB GURU** ve stavu **ke kontrole**. Doklady se exportují do CSV nebo JSON. Tisk probíhá přes prohlížeč (80 mm podle konkrétní tiskárny).

## Nasazení jednoho balíčku na Vercel

Použít **existující projekt pro `stav-app-ok`**, větev `main`, **Root Directory ponechat prázdné / kořen repozitáře**, Framework **Other**, bez buildu. Kořenový `vercel.json` zachovává vstup do PUB GURU a přidává `/pokladna` → `/pub_bizz_pos/index.html`. Nasazení pouze složky `pub_bizz_pos` by neobsahovalo obrazovky inventury a faktur. Původní GitHub Pages workflow publikuje pouze `pub_guru`; jeho staré adresy zůstávají funkční a odkaz na společnou pokladnu je v tomto samostatném režimu skrytý.

Přímé vytvoření produkčního deploymentu v připojeném účtu Vercel dne 25. 9. 2026 vrátilo **403 — chybějící oprávnění**. To není potvrzení publikovaného webu. Zdrojové soubory jsou připravené pro standardní nasazení existujícího repozitáře.

Backend je nasazený v PUB GURU:

- migrace `20260925174410_pub_bizz_shared_register`, `20260925174607_pub_bizz_payment_reservations`, `20260925175141_pub_bizz_inventory_snapshot`;
- Edge Function `pub-bizz-pos`, zapnuté `verify_jwt` a další ověření uživatele přes Auth;
- browser používá pouze veřejný publishable key z `config.js`. Service role zůstává v prostředí Edge Function.

Při změně doménového kódu spustit z kořene `python3 pub_bizz_pos/sync-edge.py` a nasadit aktualizovaný obsah `supabase/functions/pub-bizz-pos`. Migrace v repozitáři odpovídají skutečně přiděleným verzím v databázi; původní PUB GURU schema je v adresáři `database`.

## Integrita a oprávnění

- Pro každou provozovnu je jeden autoritativní stav. Frontend posílá příkazy, nemůže poslat vlastní tržby ani přepsat celý stav.
- PostgreSQL zamkne řádek pokladny, ověří revizi, uloží účtenku, skladové pohyby, audit a případnou uzávěrku v jedné transakci. Nesouhlas revize vyvolá nové vyhodnocení příkazu na serveru.
- Každý příkaz má UUID a kontrolní hash obsahu. Prohlížeč uloží identifikátor před odesláním. Při ztracené odpovědi se opakuje stejný požadavek; nová platba zůstane zablokovaná do ověření.
- Platba navíc kontroluje revizi účtu a rezervaci. Ceny a receptura se zachytí do dokladu a pozdější úprava ceníku ho nepřepíše.
- Serverově ověřená role staff markuje a přijímá platby; owner/manager spravuje ceník, receptury, vratky, hotovost a uzávěrky. Accountant má čtení. RLS omezuje čtení na členství v organizaci. Tabulky pokladny nemají přímé zápisové oprávnění pro klienta; interní commit RPC je dostupné jen service role.
- Inventura čte úplný skladový přehled v jednom SQL snapshotu, včetně příjmů z faktur a odpisů POS. Obnovuje se po 10 sekundách, při návratu do okna a před uložením měření; aktualizace zachová rozepsané měření a fakturu. Uložená dřívější měření se zpětně nepřepočítávají.
- Peníze jsou v haléřích. Do původní tabulky uzávěrek se převádějí na Kč. Hotovost zaokrouhlená na Kč, karta přesná, kombinace v celých Kč hotově a přesný zbytek kartou.
- Jde o první sdílenou verzi: historie je zatím součástí JSON stavu, bez archivace a stránkování dlouhodobé historie. Vratka se provádí jen v otevřené směně původního prodeje.

## Původní místní verze

`PUB-BIZZ-pokladna-offline.html` je oddělená nouzová pokladna pro jedno zařízení. Její data se automaticky nepřičítají do společných tržeb a skladu. Původní data v prohlížeči se nemažou; tlačítko v Nastavení stáhne jejich kopii. Lokální soubor se obnoví příkazem `python3 pub_bizz_pos/build-standalone.py`. Místní záloha nesmí přepsat společný serverový stav. Místní a sdílenou pokladnu nepoužívat současně pro stejný účet.

## Ověření

```sh
node --test tests/pub-bizz-pos.test.js tests/pub-bizz-server.test.js
npm ci --prefix tests/pos-web
npm test --prefix tests/pos-web
```

`tests/pub-bizz-database.sql` ověřuje v transakci zakončené ROLLBACK atomický odpis, deduplikaci, konflikt revizí, chybějící recepturu, dodatečný odpis, fyzickou vratku, nedostatek kusových zásob, uzávěrku a izolaci cizího uživatele. Testovací tržby ani zásoby v databázi nezůstávají.

UI testy používají DOM a simulovaný transport k otestování ztracené odpovědi po úspěšném commitu, opakování stejného UUID, platební rezervace a zachování rozpracované inventury. Nejsou testem přihlášení konkrétního uživatele ani reálného telefonu/tiskárny. U nasazené Edge Function je ověřený preflight 204 a odmítnutí nepřihlášeného požadavku 401.

Kontrola celého repozitáře lokálně: 33 unit/contract testů prošlo; další 4 DOM testy online pokladny a inventury prošly. GitHub Actions pro commit `9452160` skončilo stavem failure i po jednom opakování, bez dostupného logu nebo kroků jobu. Automatický Pages deploy byl přeskočen; kontroly nebyly vypnuty ani obejity.
