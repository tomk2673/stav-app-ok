# Oprava namarkování a přesuny účtu — 22. 10. 2026

Vedle částky je tlačítko **Zpět · 5 s**. Vrací přesně poslední přidanou dávku, včetně více kusů a 2cl porce, jedním opravným zápisem. Odpočet běží po úspěšném místním uložení. Přepnutí hosta, změna účtu, platba nebo vypršení času opravu znepřístupní. Peníze, starší objednávky ani skladové výdeje se tím nevracejí.

U částky jsou **Rozdělit**, **Přesun účtu** a **Přesun položek**. Telefon má tuto lištu stále dole; tablet a PC ji mají pod položkami účtu. Vybrané položky se přesouvají po zadaných kusech na vyhledaný stůl nebo hosta. Při částečném přesunu zůstává vybraný původní účet se zbytkem. Přesun všech položek otevře cílový účet. Ceny, DPH, návštěvy, kredit a původní skladové rozsahy zůstávají zachované. Přesun nevytváří platbu ani nový skladový pohyb.

Při rozdělení dlouhého účtu zůstává součet i potvrzení platby viditelné. Výběr počtu vrací seznam nahoru; po zaplacení části se otevře nabídka nápojů od začátku na stejném hostovi. Rozložení se řídí dostupnou výškou displeje, skutečnou výškou spodní lišty a bezpečnými okraji; není potřeba vybírat model telefonu.

Na úzké ploše do 359 CSS px zůstávají početní zkratky v jednom řádku: 1/2/3 a Jiný počet. Další množství se zadává velkou klávesnicí. Běžná synchronizace nevykresluje překážku přes nápoje; čekající množství je označené u účtu a ve stavové liště.

## Protokol a vydání

- Kanonický kód je v `pub_bizz_pos`; Edge kopie vznikají přes `sync-edge.py`, nouzové HTML přes `build-standalone.py`.
- Vybrané přesuny rozšiřují existující atomický příkaz `mergeOrders` o `selected`. Oprava rozšiřuje `removeLine` o množství a odkaz `undoOf` na audit původního namarkování. Zůstává ochrana obou revizí, platebních rezervací, obsluhy a opakovaných UUID.
- Server musí oznamovat `accountActionsProtocol:1`. Starší server nové volby nezapne. Rozšířené požadavky navíc používají značku protokolu 2, kterou starší server odmítne; nemůže je vyložit jako přesun celého účtu nebo odebrání jednoho kusu. Nový server nadále přijímá stávající protokol 1.
- Nejprve nasadit kompletní Edge funkci `pub-bizz-pos` projektu `gnfqlfxuagcgjztaueot` se zachovaným `verify_jwt:true`. Poté vydat otestovaný web do existujícího projektu Vercel `pub-bizz-pokladna` a přes stávající workflow GitHub Pages. PWA cache má verzi `2.0.23`. Nová SQL migrace není potřeba.
- Při problému vrátit web, zachovat nový server, dokud nejsou potvrzené všechny fronty. Úložiště a čekající UUID nemazat. Při návratu starého serveru zůstane nepodporovaná čekající oprava viditelná jako konflikt místo částečného provedení.

## Ověření

- Jednotkové testy prohlížečového i serverového jádra: dávkové vrácení, přesuny kusů, staré revize, rezervace, neplatné výběry a disjunktní rozsahy dříve vydaných porcí.
- DOM testy skutečného místního deníku: okamžitá oprava při držené síťové odpovědi, offline opakování, odpočet, změna hosta, ztracená odpověď přesunu a ochrana proti starému serveru i jeho návratu.
- `npm run test:accounts --prefix tests/pos-browser`: Chromium a WebKit, šířky 320/390/900/1440 px, skutečný SDK a rozložení, vrácení pěti kusů, částečný a celý přesun a dostupnost rozdělení. Fiktivní API odpovědi jsou zachycené; skutečné tržby a sklad nejsou testovací data.
- Zachované provozní testy a kompletní DOM/PostgreSQL sada. To nenahrazuje fyzický test iPhonu a konkrétního počítače za barem.
