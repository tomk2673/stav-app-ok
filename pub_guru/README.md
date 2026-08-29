# STAV. – funkční MVP

Mobilní PWA pro:

- OCR fotografií a PDF faktur,
- kontrolu položek a naskladnění,
- skenování EAN přes kameru,
- váhovou inventuru běžnou kuchyňskou váhou,
- produktový koeficient ml/g, táru a teplotní korekci,
- samostatný stav každé inventurní a fakturační položky,
- ruční zápis prodeje, nákladů, hrubého zisku a marže,
- lokální uložení dat a export/import zálohy.

## Spuštění

Nejlépe přes lokální HTTPS nebo běžný webhosting. Kamera na iPhonu vyžaduje HTTPS.

Jednoduchý lokální test na počítači:

```bash
python3 -m http.server 8080
```

Pak otevřít `http://localhost:8080`.

## Důležitá přesnost

Výchozí teplotní korekce je pouze provizorní. U každého konkrétního SKU je potřeba doplnit:

- EAN,
- objem balení,
- táru,
- hmotnost plné lahve nebo ověřený koeficient,
- produktový teplotní koeficient,
- skladovací zónu.

Aplikace schválně neodvozuje hustotu pouze z procent alkoholu. Stejné ABV neznamená stejnou hustotu.

## Omezení MVP

- OCR položky rozpozná a připraví k ruční kontrole, není to účetní autopilot.
- Pro teoretický sklad se prodeje zatím zapisují ručně. Další krok je import z pokladny a receptury míchaných nápojů.
- Foto měření hladiny je připravené jako další modul, váhová inventura je nyní plně funkční.
