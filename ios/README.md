# PUB INVOICES pro iOS

Nativní obal načítá `https://pub-bizz-pokladna.vercel.app/pub_guru/start.html`.
Adresa byla 9. 10. 2026 ověřena: HTTPS 200 pro start, faktury a OCR most;
Vercel ji přiřazoval produkčnímu mainu `9ee8d62fd36d042753942f0489d6bcdfe1339dd0`.
Nejde o preview ani historickou větev. Adresáře a databázový projekt zůstávají stejné.

## Čtení faktur

| Prostředí | Výchozí čtení | Při chybě | Fotografie |
| --- | --- | --- | --- |
| Nainstalovaná iOS aplikace | Apple Vision v telefonu, bez API klíče | Tesseract v prohlížeči | Fotoaparát/výběr souboru a nativní synchronizace alba |
| Safari / PWA / ostatní web | Tesseract v prohlížeči, bez placeného API | Viditelná chyba, pokud se OCR knihovna/model nenačte | Fotoaparát/výběr souboru; bez nativní synchronizace alba |

Jednotlivá fotografie se ihned čte a před uložením vyžaduje kontrolu povinných
údajů. Dávkový výběr a synchronizace alba dál ukládají zdroje do fronty pro
pozdější zpracování; samotné přidání do fronty není dokončené OCR ani schválení faktury.

Serverové AI čtení je výslovná, ve výchozím stavu vypnutá volba. Odesílá dokument
na `/api/invoice-vision`, vyžaduje přihlášení a nakonfigurovaného poskytovatele.
Chybějící klíč, HTTP chyba nebo timeout přejdou na místní OCR. PR #22 se touto
opravou neaktivuje. Místní OCR nepotřebuje placené Vision API; web, modely Tesseractu
a ukládání do Supabase přesto potřebují připojení. Nejde o plně offline aplikaci.

Nativní OCR přežije i výpadek CDN Tesseractu. Chyba mostu, nerozpoznaný text,
neplatná odpověď nebo timeout vrátí původní canvas a nastavení Tesseractu. Předané
řádky a důvěra se zachovají. U dokumentu čteného oběma enginy se oba zapíší do
faktury i auditu. Dostupný nativní most sám o sobě není důkazem použitého OCR.

## Přihlášení a zachování dat

Bundle ID `cz.pubguru.app`, trvalý `WKWebsiteDataStore.default()`, Supabase
projekt a klíč zpracovaných fotografií v UserDefaults zůstávají stejné.
Změna z raw.githack.com na produkční origin jinak znamená oddělené localStorage.

Při první aktualizaci se proto pouze klíč relace tohoto Supabase projektu,
kontext PUB INVOICES a vybrané album čtou přes lokální prázdný HTML dokument
s blokovaným síťovým obsahem. Historická vzdálená aplikace se nenačítá. Klíče
se převedou přes paměť do produkčního originu bez URL parametrů a logování.
Existující produkční přihlášení a jeho kontext se nepřepisují. Původní data se
nemažou. Úspěšný převod se provede jednou, takže pozdější odhlášení neobnoví
starou relaci. Pokud převod selže nebo relace už není platná, aplikace se dál
otevře a může vyžádat přihlášení. Safari/PWA a nativní aplikace nesdílejí relaci.

Mosty Vision a Fotek přijímají jen hlavní rámec důvěryhodné HTTPS produkční
stránky `/pub_guru/`. Po navigaci se staré odpovědi nepředají jiné stránce.
Externí HTTPS odkazy se otevírají v Safari. Oprávnění fotoaparátu a knihovny
fotografií zůstávají v Info.plist; omezený přístup k vybraným fotkám je podporován.

## Ověření a vydání

```bash
node --test tests/*.test.js
npm ci --prefix tests/pos-web
npm test --prefix tests/pos-web
cd ios
brew install xcodegen
xcodegen generate
xcodebuild test -project PubGuru.xcodeproj -scheme PubGuru \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
```

Workflow `PUB INVOICES iOS` zvolí dostupný iPhone simulátor a provede skutečné
Apple Vision čtení generované faktury, chyby obrázků, orientaci, pravidla originu
a přenos relace v reálném WebKitu. JS regresní testy ověřují celou cestu od
události fotoaparátu přes most, parser a uložené položky k auditní stopě a
načtení existující historie. Backend a odpovědi mostu jsou v JS testech mockované;
nejsou důkazem přesnosti OCR reálné dodavatelské faktury ani živého zápisu do DB.

Před vydáním musí projít webové i iOS CI. Webová oprava se nasazuje sloučením
PR do mainu. Aktualizace nativního obalu vyžaduje nový podepsaný build se stejným
bundle ID, instalačním týmem a oprávněními. Samotná změna webu starou iOS
binárku z historické adresy nepřesměruje.

**Fyzický iPhone: instalace, přístup k fotoaparátu/Fotkám, reálná faktura,
obnovení existující přihlášené relace a opětovné otevření historie zatím
neověřeny.** Simulátorové testy tuto provozní kontrolu nenahrazují.
