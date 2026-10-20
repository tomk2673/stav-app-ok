# Lokální markování PUB POS — vydání 20. 10. 2026

## Chování

Přidání, odebrání a změna počtu položek potvrdí trvalý místní záznam a ihned překreslí účet. Zápisy na server běží na pozadí. Každá změna má neměnné UUID a obsah; uložení předchází síti. Stejné UUID se po výpadku i reloadu opakuje a server je ověřuje spolu s hashem obsahu. Identifikátory a záměry jsou v oddělených klíčích localStorage pro provozovnu/obsluhu; potvrzený stav je v samostatné IndexedDB s transakční kontrolou revize. Snímky celé historie nezabírají malé úložiště fronty. Ani selhání zápisu nesmí zobrazit úspěšné přidání nebo přepnout skutečný cíl na jiného hosta.

Účet se obnoví pod zvoleným hostem/stolem. Příkaz drží původní ID, jméno, zákaznickou identitu, směnu, cenu a porci. Souběžná přidání lze vyhodnotit nad novější revizí. Oprava počtu navíc kontroluje původní počet i poslední změnu řádku. Platba, přejmenování, spojení či jiná hranice účtu znemožní pozdní automatické připsání. Konflikty se rozhodují na serveru a jejich UUID se trvale spotřebuje v témže pos_commit; opakování odmítnutého UUID již nemůže později změnit účet. Tlačítko „Ponechat stav serveru“ zahazuje jen takto potvrzené odmítnutí. Neodeslaný nebo nejistý zápis nelze tiše zahodit.

Platby, rezervace, kredit, vratky, převody a uzávěrky nadále čekají na server. Při čekající frontě není možné otevřít novou platbu. Nejde o offline přijímání peněz. Zrušení platby #49 zůstalo zachované. Nouzové samostatné HTML nadále používá svůj oddělený režim a úložiště.

## Měření

Srovnání se skutečným zdrojem mainu `82d251ac2955bf6dd96b01f03a61155678a0b964`. Headless Linux, Chromium 134 a WebKit 18.4; HTTP obsluha přidává řízené zpoždění **600 ms** každému zápisu. Čas je měřen od kliknutí po dva requestAnimationFrame po změně počtu v DOM; tabulka uvádí medián šesti opakování. Výsledky nejsou měřením fyzického iPhonu, Windows 7 ani skutečné linky baru. Skutečné tržby nejsou testovací data.

| Prohlížeč | Šířka | Před | Po |
|---|---:|---:|---:|
| chromium | 390 px | 656 ms | 23 ms |
| chromium | 900 px | 630 ms | 22 ms |
| chromium | 1440 px | 631 ms | 19 ms |
| webkit | 390 px | 673 ms | 104 ms |
| webkit | 900 px | 694 ms | 103 ms |
| webkit | 1440 px | 738 ms | 190 ms |

Počet doteků na již vybraném účtu:

| Počet kusů | Před | Po |
|---|---:|---:|
| 1 | 1 | 1 |
| 5 | 2 | 2 |
| 12 | 6 | 5 |

Dvacet programových doteků v jednom běhu se trvale uložilo a zobrazilo za 36 ms v Chromium a 64 ms ve WebKitu, ještě před síťovým potvrzením. Syntetická historie 6 000 událostí / 3,52 milionu znaků prošla ukládáním do IndexedDB i přidáním bez zahlcení localStorage. Potvrzování fronty nadále závisí na serveru a kvalitě spojení.

Úplné vzorky a scénáře: [JSON](../tests/results/pos-marking-20261020.json), reprodukce `npm run test:marking --prefix tests/pos-browser` (vyžaduje historii gitu a nainstalované Chromium/WebKit). Všechny API odpovědi v tomto testu poskytuje místní HTTP server; CSP zakazuje externí připojení. WebKit při offline reloadu používá skutečně nedostupný origin, protože simulace setOffline v Playwright blokuje i odpovědi service workeru.

## Ověření

- 191 jednotkových/kontraktových a 148 DOM/PostgreSQL testů prošlo; nevykazují skutečnou přesnost ani funkčnost nesouvisejícího OCR.
- PGlite test spustil skutečnou aktuální definici produkčního pos_commit nad izolovanými fiktivními daty: konflikt revize → nové vyhodnocení přidání → jediné uložení UUID; odmítnuté UUID zůstává odmítnuté při opakování. Žádná změna peněz ani skladu při markování/odmítnutí.
- Chromium i WebKit: 390/900/1440 px nové markování, šest srovnávacích vzorků; offline PWA reload se stejným hostem a 2cl porcemi, ztracená odpověď, 20 doteků, stabilní poloha produktů, souběh telefonu/PC, trvalý konflikt a velká historie.
- Původní úplné provozní toky: Chromium 390/900/1440 a WebKit 390/900; přihlášení/obnova, rychlý prodej, vyhledávání hostů, počet, 2 cl, dělení, hotovost/karta/kredit, zrušení/obnova platby, vratky, návštěvy, řazení produktů a rozložení.
- Skutečné service workery obou aplikací: obnova Chromium/WebKit po přesměrování a výpadku, zachovaný deník i IndexedDB.
- Syntaxe JS/TS a git diff --check prošly. Build nouzového HTML a Edge kopie jsou ze stejných kanonických souborů.

## Nasazení

1. Cíl: stávající Supabase PUB GURU `gnfqlfxuagcgjztaueot`, funkce `pub-bizz-pos`. Živá verze 15 před změnou přesně odpovídala souborům hlavní větve; `verify_jwt=true` a existující ověřování uživatele/členství zůstává. Nová SQL migrace není potřeba, schéma ani historická data se nepřepisují.
2. Po úspěšných CI kontrolách nasadit kompletní `supabase/functions/pub-bizz-pos` včetně marking.js a import mapy. Potvrdit shodu publikovaných bajtů a zachování ověřování JWT. Až nový server oznamuje `markingProtocol:1`, web používá lokální režim; proti starému serveru zůstává přísný síťový režim.
3. Sloučit přesný otestovaný commit do současného mainu a ověřit Vercel projekt `pub-bizz-pokladna`, ID `prj_90pqiz6g2BHtey1JmKyGAkxuF8tB`, tým `team_2LOaoYf5B9AiKZZnIdkItxaW`. PWA cache je `2.0.21`. GitHub Pages publikuje existující workflow až po testech.
4. Ověřit stav deploymentu a shodu HTML, JS, CSS a service workeru na `/pokladna` / `/pub_bizz_pos/…`; nepoužívat skutečnou platbu ani sklad jako smoke test.

## Bezpečné vypnutí

V nové konfiguraci lze přidat `localMarking: false` a vydat nový web/cache. Nové zápisy pak čekají na server; existující fronta se nadále obnovuje, ověřuje a zpracovává. Tento postup prošel regresním testem. Při vypínání zachovat nový cloud.js, marking.js, IndexedDB i kompatibilní server, dokud nejsou fronty potvrzené a konflikty vyřešené. Starší web neumí nové konflikty a není vhodný k přímému návratu s nerozhodnutými záměry. Úložiště ani UUID se nemažou. Ostatní rozpracované PR, včetně faktur, nejsou součástí vydání.

## Změnový přenos a skutečná blokace poskytovatele

Při ověření veřejného API vrací Supabase **HTTP 402 / exceed_egress_quota**. Organizace `ytofuoixaxxatwqnnmho` je podle Management API na tarifu **Free**. Management API a nasazení funkcí fungují; aplikační datový provoz je poskytovatelem omezený. Změna kódu nemůže zpětně obnovit vyčerpanou kvótu. Tarif, platební prostředky a výdajové limity nebyly měněny. Dokud poskytovatel službu neobnoví, nelze potvrdit autorizovaný provoz přes skutečné veřejné API ani tvrdit, že pokladna plně funguje.

Nový `sync.js` používá ověřený kurzor revize a posledních ID neměnné historie. Při změně posílá kompletní aktuální pole stavu a jen nové řádky auditu/dokladů; při porušeném prefixu načte úplný snímek. Nezměněný GET načte jen číslo revize a neposílá historii. Doplňková skladová metadata se obnovují nejpozději po minutě nebo po příkazu. Ve velkém syntetickém testu klesla odpověď z 3 518 640 znaků na **39 672** pro změnu a **487** při nečinnosti. Toto je měření obsahu, ne předpověď měsíční faktury. Starší klienti bez kurzoru nadále dostávají původní úplný formát.

Obě P2 připomínky kontroly jsou opravené: všechna programová přepnutí používají jednotné trvalé uložení cíle (včetně spojení, vrácení dokladu a odstranění účtu) a nezměněné odpovědi ani nezměněná projekce znovu nerenderují Nastavení. Regrese ověřují offline reload na cíli po spojení, zachování rozepsaného formuláře a uchování UUID při HTTP 402.
