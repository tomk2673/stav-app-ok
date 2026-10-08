# PUB POS: kompatibilita Windows 7

Kontrola 8. 10. 2026, výchozí main `ff59705c1176a730c3cfa1290ea839992e26a5d5` (PR #23). Platební, skladový a serverový doménový kód se v této opravě nemění.

## Použitelná konfigurace

Na Windows 7 je doporučená konfigurace **Windows 7 SP1 + nejnovější opravený Firefox ESR 115**, běžné okno, povolený JavaScript a data webu, správné datum/čas, funkční internet a adresa **https://pub-bizz-pokladna.vercel.app/pokladna**. K 8. 10. 2026 je doložená verze ESR 115.41.0. Ověřená základní hranice enginu je Firefox 115 nebo Chromium 109; starší verze nejsou garantované.

| Prohlížeč na Windows 7 | Výsledek a omezení |
| --- | --- |
| Firefox ESR 115, nejnovější bezpečnostní oprava | Doporučená varianta; Mozilla aktuálně uvádí aktualizace do března 2027. Samotný Windows 7 je nepodporovaný. |
| Chrome / Edge 109 | Poslední oficiální major verze pro Windows 7. Chromium 109 prošel níže uvedenými testy, ale Chrome/Edge 109 už nedostávají běžné bezpečnostní aktualizace; nejsou doporučenou provozní volbou. Edge nebyl samostatně spuštěn. |
| Internet Explorer 11 a výrazně starší Chrome/Firefox | Nepodporované: chybí potřebná syntaxe a/nebo webové API. Zobrazí se vysvětlení místo trvalého „Načítám“. |
| Aktuální iPhone, tablet, současný PC | Regresní testy zahrnuly WebKit s mobilním viewportem a dotykem i novější Chromium. Fyzická zařízení nebyla připojená. |

## Co skutečně vyžaduje kód

- Aplikační skripty používají ES2020 (optional chaining a nullish coalescing). Přibalený, nezměněný `supabase-2.117.2.js` obsahuje i syntaxi ES2021. Všechny skripty načítané z `index.html` byly parsované s hranicí ES2021; samotné hlášení při startu se parsuje jako ES5. Optional chaining ani `Object.fromEntries` nejsou problémem v Chromium 109 / Firefox 115.
- Používají se `fetch`, `AbortController`, `FormData`, `URL`, `URLSearchParams`, `TextEncoder`, `Intl`, `Map`, `Set`, `Object.fromEntries`, `String.normalize`, `replaceAll`, nativní `dialog.showModal/close` a kryptografická API. Zůstávají původní fallbacky `globalThis`, JSON kopie prostých dat přes `structuredClone` a UUID v4 z `crypto.getRandomValues`. ID operací nikdy nejsou nahrazená `Math.random`.
- Supabase Auth zachovává původní `persistSession`, obnovu tokenů a výchozí klíč `sb-gnfqlfxuagcgjztaueot-auth-token`, sdílený s PUB INVOICES na stejné doméně. Změna neresetuje relace, nevypíná zámky Auth a nemění oprávnění.
- `localStorage` je pro sdílenou pokladnu nutný kvůli přihlášení a trvalým ID nepotvrzených příkazů. Při jeho zablokování nebo nedostatku místa pokladna nedostane náhradní paměťový režim. Kontrola zapisuje/čte/odstraní vlastní unikátní zkušební klíč, bez mazání relací či existujících příkazů. Samotné příkazy nadále ukládají svůj původní journal před odesláním.
- IndexedDB slouží oddělené nouzové pokladně a stažení jejích starších dat. Sdílené účty zůstávají na serveru. `storage.js` již má fallback pro nepodporovanou volbu `durability: strict` a volitelný `BroadcastChannel`; nebylo potřeba měnit jeho logiku.
- HTTPS je nutné pro zabezpečené API, Web Crypto a service worker. Výjimkou pro vývoj je loopback. Nepoužívat `file://` pro sdílenou pokladnu ani obcházet chyby certifikátu. PWA/service worker není podmínkou online markování; Firefox na PC může fungovat jako běžná stránka.

## Doložené chyby a oprava

1. **Selhání SDK spouštělo místní pokladnu.** V původním Chromium 109 bylo zablokované načtení Supabase. `cloud.js` skončil na `Cannot read properties of undefined (reading 'createClient')`, ale `app.js` otevřel IndexedDB, zobrazil „Místní pokladna“ a tlačítko pro otevření směny. Nově cloudový bootstrap a UI chybu zachytí a sdílená stránka neotevře místní režim. Totéž platí pro chybějící součásti/config nebo výjimku při vytvoření klienta.
2. **Chyběla kontrola základních API, HTTPS a zapisovatelného úložiště.** Nově je v ES5 `compat.js`, takže vysvětlení může zobrazit i starý prohlížeč, který samotnou aplikaci neumí parsovat. Zachycuje také nedostupné skripty včetně `app.js`.
3. **Nouzový HTML soubor závisel na vnějším `compat.js`.** Generátor nyní vloží guard/polyfilly přímo do HTML. Samostatný soubor byl otevřen přes `file://` bez ostatních souborů ve všech testovaných enginech.
4. Cache shellu je zvýšená na `pub-bizz-pos-shell-2.0.5`. Přihlašovací a platební data se nemažou.

## Ověření a jeho hranice

**75 automatických kontrol:** 46 jednotkových/kontraktových + 29 DOM testů, včetně sedmi nových kontrol bootstrapu, zachování uložených dat, syntaxe a nouzové kopie. Kontroly syntaxe Node a `git diff --check` prošly.

**12 úplných toků ve skutečných enginech na Linuxu:**

| Engine | Verze | Šířky obrazovky |
| --- | --- | --- |
| Chromium | 109.0.5414.46 | 320, 390, 900, 1440 px |
| Firefox | 115.0 | 390, 900, 1440 px |
| Chromium | 134.0.6998.35 | 390, 900, 1440 px |
| WebKit | 18.4 | 390 px s mobilním režimem a dotykem, 900 px |

Každý tok načítá skutečný přibalený Supabase SDK. Odpovědi **Auth a Edge Function jsou simulované**, nikoli metody klienta. Ověřeno: odmítnutí špatného hesla, správné přihlášení, jedna obnova tokenu po 401, obnovení přihlášení po reloadu, otevření směny, vytvoření a hledání stolu/zákazníka bez diakritiky, 12 kusů na klávesnici, oprava na 5, rozdělení položky a návrat k dalším položkám, povinné potvrzení terminálu, zachování zbytku účtu, hotovostní platba a okamžité další markování. Ztracená odpověď je obnovena po reloadu se stejným ID bez duplicit. Prošel i IndexedDB backup, kontrola vodorovného přetékání a viditelnost součtu/placení na PC a tabletu.

V každém ze čtyř enginů navíc prošlo šest scénářů: chybějící SDK, chybějící aplikace, zablokované úložiště, plné úložiště, chybějící moderní API a samostatný nouzový soubor. Výpadkové scénáře nevytvoří místní účet místo sdíleného.

Na veřejné produkční adrese bylo samostatně ověřeno přesměrování `/pokladna` → `/pub_bizz_pos/index.html`, HTTPS s ověřením certifikátu, HTTP 200, HSTS a původní CSP bez `unsafe-eval`. Živé Supabase Auth settings vrátily 200 s povoleným e-mailovým přihlášením; Edge Function bez přihlášení vrátila 401 a odpovídající CORS hlavičky. To **není** ověření hesla či členství konkrétního uživatele.

**Neověřeno:** skutečné Windows 7, jejich konkrétní profil/certifikáty/rozšíření, fyzický iPhone/tablet, přihlášení uživatele do živé provozovny a fyzický platební terminál. Firefox 115 v testu je automatizační Linux build, nikoli Windows ESR 115.41. V izolovaném testovacím prostředí bylo nutné vypnout Firefox content sandbox a dodat Linux knihovny pro WebKit; nastavení aplikace ani její CSP to nemění. Testovací Auth/Edge odpovědi nevytvořily žádné produkční účty, tržby ani skladové pohyby.

## Zbývající překážky a kontrola na PC

Na konkrétním Win7 PC zůstává nutné ověřit normální přihlášení a obnovu relace v jeho prohlížeči. Správný čas, důvěryhodné certifikáty, internet a povolené ukládání dat nemůže opravit JavaScript pokladny. Při chybě certifikátu neobcházet varování; zkontrolovat čas, aktualizace prohlížeče a důvěryhodný certifikát. Při chybě úložiště uvolnit místo/povolit data webu bez smazání nepotvrzených příkazů. Účet bez členství v provozovně musí být přidělen správcem; kód oprávnění neobchází.

Po nasazení zavřít a znovu otevřít stránku nebo použít **Ctrl+F5** pro aktualizaci souborů. Nemazat data webu. Otevření směny a první skutečnou platbu ověřit při běžném provozu; na terminálu platbu nikdy neopakovat jen kvůli chybě odpovědi webu.

## Reprodukce

```sh
node --test tests/*.test.js
npm ci --prefix tests/pos-web
npm test --prefix tests/pos-web
npm ci --prefix tests/pos-browser
npm run install-browsers --prefix tests/pos-browser
npm test --prefix tests/pos-browser
```

Na běžném Linuxu mohou být potřeba systémové závislosti pro Firefox/WebKit (`playwright install-deps`). Jednotlivé enginy lze vybrat například `POS_BROWSER_PROFILES=pw109/chromium,pw115/firefox`. JSON výsledky lze uložit přes `POS_BROWSER_RESULTS=/absolutni/cesta/results.json`. Původní CSP zůstává zapnutá; polling starého Playwright byl přizpůsoben tak, aby nepoužíval `unsafe-eval`.

Primární zdroje, ověřené 8. 10. 2026:

- [Mozilla: Firefox pro Windows 7 / ESR 115 a prodloužení podpory](https://support.mozilla.org/en-US/kb/firefox-users-windows-7-8-and-81-moving-extended-support)
- [Firefox ESR 115.41.0, vydání 15. 9. 2026](https://www.firefox.com/en-US/firefox/115.41.0/releasenotes/)
- [Google: požadavky Chrome a poslední verze pro Windows 7](https://support.google.com/chrome/a/answer/7100626)
- [Microsoft: životní cyklus Edge](https://learn.microsoft.com/en-us/lifecycle/products/microsoft-edge)
- [Supabase: signInWithPassword](https://supabase.com/docs/reference/javascript/auth-signinwithpassword)
- [MDN: optional chaining](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Optional_chaining)
- [MDN: Object.fromEntries](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/fromEntries)
