# Integrace AI faktur: stav a nasazení

## Ověřený stav 15. 10. 2026

Integrace vychází z produkčního mainu `7a6e6570b733e99d1c8825469cd53f7f15623283` a zachovává změny PR #34, #35 a #37. Soubory pokladny ani její Edge Function se touto integrací nemění. Produkční finanční a skladová data nejsou testovacími vstupy.

| Místo | Skutečný výsledek kontroly před integrací |
| --- | --- |
| `https://pub-bizz-pokladna.vercel.app/pub_guru/invoice-capture.html` | HTTP 200, aktuální aplikace |
| `https://pub-bizz-pokladna.vercel.app/api/invoice-vision` | HTTP 405 při GET; existující serverový endpoint přijímá POST |
| `https://pub-guru.vercel.app/api/invoice-vision` | HTTP 404, starý projekt bez API |
| GitHub Pages `tomk2673.github.io/stav-app-ok` | Statická aplikace HTTP 200; `/api/invoice-vision` HTTP 404 |
| Serverový klíč | Žádný `OPENAI_API_KEY` v prostředí ani v projektech `pub-bizz-pokladna`, `pub-guru`, `pub-guru-v1-test`; kontrolovány pouze názvy proměnných, nikoli hodnoty |
| Supabase `gnfqlfxuagcgjztaueot` | Queue RPC již existuje; `private.complete_invoice_capture_on_post`, příslušný trigger a tabulka `invoice_drive_sources` chybějí; funkce `invoice-drive-import` dosud není nasazená |

Žádný skutečný OpenAI požadavek nebyl proveden. Chybějící klíč je blokátor zapnutí AI v produkci. Žádný nový klíč není vytvořen, žádný tajný údaj není součástí změn a žádná produkční migrace není v této fázi provedena.

## OpenAI API: poslední oprava

Serverový endpoint používá OpenAI Responses API, strict JSON Schema a zachovává původní dokument pro přímé vision čtení. Pokud není nastavena `OPENAI_INVOICE_MODEL`, bezpečný výchozí model je `gpt-4.1` (vision + Structured Outputs); lze jej explicitně přepsat pouze serverovou proměnnou. Regresní test ověřuje, že POST i readiness GET používají stejný výchozí model a že GET nevolá placený model. Klientská aplikace nikdy nedostává `OPENAI_API_KEY`.

## Co integrace zajišťuje

- Jednotlivé dokumenty a dávková fronta používají stejný AI endpoint. Selhání neskrývá automatické přepnutí na místní OCR. Místní OCR zůstává výslovnou volbou.
- Pages míří na existující server Vercel. CORS povoluje konkrétní origin; bearer token se neposílá na URL z dokumentu. Endpoint ověřuje živou Supabase relaci, roli owner/manager/staff i příslušnou provozovnu. Klíč je pouze v serverovém prostředí. Odpovědi nejsou cacheované; autentizovaný GET ověřuje konfiguraci bez placeného volání modelu.
- Fotoaparát, dávka a uložený jednotlivý doklad uchovávají původní bajty v soukromém `invoice-sources`; komprese se týká jen pracovní kopie pro AI. Drive ověřuje SHA-256 i přenos po výpadku; privátní opakované stažení používá `/object/authenticated/`. Neztrácí se originál po ztracené odpovědi zápisu úlohy.
- Zachovává se cena/MJ, vytištěná sleva a výsledná cena řádku. Celá faktura se nezaměňuje za zůstatek po záloze. Nepřečtené hodnoty nejsou nuly. Cizí či neznámá měna je blokovaná také při schvalování dávky. Kartony a litry vyžadují skutečný převod na skladové množství.
- Před zaúčtováním zůstává ruční schválení, kontrola součtů, DPH a množství. PR #35 dokončuje frontu v transakci s auditem/skladem; PR #37 zachovává vazbu originálu i po úklidu dokončené úlohy.

## Pořadí dokončení

1. V týmu `pwc82cgt2v-7189s-projects`, projektu **pub-bizz-pokladna** (`prj_90pqiz6g2BHtey1JmKyGAkxuF8tB`) bezpečně připojit stávající `OPENAI_API_KEY` jako serverový secret pro cílové prostředí. Hodnotu nezveřejňovat, nevkládat do repozitáře, `app-config.js`, `NEXT_PUBLIC_*`, komentářů, výpisů ani klientského storage. Klíč z jiného systému nelze zpětně získat z OpenAI Platform. Vytvoření náhradního klíče vyžaduje uživatelovu volbu v zabezpečeném nastavení.
2. Z přesného integračního commitu vytvořit preview se serverovým API, po připojení klíče jej znovu sestavit. Nasazení starší než změna proměnných nový klíč nepoužije. Volitelný `OPENAI_INVOICE_MODEL` zachovává existující model; výchozí je `gpt-4.1`. Klíč neposkytovat nezkontrolovaným větvím.
3. Provést skutečné AI čtení pěti syntetických obrázků z `tests/fixtures/invoice-vision`, porovnat položky, znaménka, množství, jednotky, DPH, slevy, celkovou částku a částku k úhradě. Samostatně ověřit skutečný autorizovaný POST na preview z Pages originu. GET readiness není důkaz přesnosti ani platnosti klíče u poskytovatele. Bez těchto testů integraci nepřepínat na produkci.
4. Z testovaného integračního stromu aplikovat `database/20261010141443_invoice_approval_queue_completion.sql` a ověřit funkci, trigger i oprávnění. Tato dosud nenasazená migrace obsahuje navíc zachování zdrojových jednotek, slev a výpočtů v `original_values`. Nemění dřívější ceny/faktury/sklad.
5. Pro Drive aplikovat `supabase/migrations/20261014054956_invoice_drive_import.sql`, nasadit `supabase/functions/invoice-drive-import` s `verify_jwt=false` dle `supabase/config.toml` (funkce má vlastní omezenou autentizaci) a zkontrolovat oprávnění úložiště. Google vyžaduje jednorázový souhlas v soukromém Apps Script projektu podle `integrations/google-drive/README.md`. Tento souhlas není udělen samotným nasazením.
6. Sloučit společnou integraci metodou merge a publikovat web/API i Pages. Ověřit přesný commit, přístup k originálu, jednu fakturu ze dvou shodných souborů, frontu `review → done` po skutečném schválení a právě jeden audit/odpovídající skladový pohyb. Obchodní data nevytvářet jako testovací transakce; použít izolovanou testovací provozovnu.

Rollback webu/API používá předchozí produkční deployment. Aditivní migrace ani originály se při rollbacku nemažou. Drive import i OCR mají vlastní opakovatelnou frontu; import lze odpojit v jeho nastavení. Do dokončení skutečného čtení a migrací zůstává produkční main beze změny.

## Testy a jejich význam

`node --test tests/*.test.js` a `npm test --prefix tests/pos-web` pokrývají aplikaci, DOM, API se simulovaným poskytovatelem a skutečný izolovaný PostgreSQL/PGlite s RLS, triggery a rollbackem. `test:invoices` ověřuje schválení/slevy/vratky/frontu v Chromium a WebKit na 390/820/1440 px. `test:drive-import` ověřuje skutečný převod HEIC, uchování bajtů, deduplikaci a AI cestu do `review` bez skladového pohybu; Google, Storage transport a AI jsou v tomto testu simulované. `test:service-workers` ověřuje obnovu navigace po výpadku. Žádný z těchto úspěchů nepotvrzuje reálnou přesnost modelu.

Oficiální podklady: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [soukromé soubory Supabase Storage](https://supabase.com/docs/guides/storage/serving/downloads), [limit požadavků Vercel](https://vercel.com/docs/functions/limitations). Kvůli limitu transportu Vercel je pracovní AI dokument omezen na 3 MiB; soukromý originál může mít až 8 MiB. Větší PDF má viditelnou chybu a zůstává dostupné k opakování.
