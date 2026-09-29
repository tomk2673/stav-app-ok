# PUB Gastro Platform

Multi-tenant gastro platforma. Každá organizace může mít více provozoven a každá provozovna má vlastní oddělený sklad a provozní data.

## Produkty

- **PUB ADMIN** — centrální správa organizace, provozoven, uživatelů, rolí, licencí a nastavení. Admin je řídicí rozhraní, ne sklad.
- **PUB POS** — pokladna, účty, prodej, směny, receptury a skladové odpisy.
- **PUB INVOICES** — faktury, dodavatelé, AI/OCR zpracování, příjem zboží, uzávěrky a audit.
- **PUB INVENTORY** — rychlá inventura nad skladem konkrétní provozovny; EAN, počty, vážení otevřených lahví a inventurní rozdíly.
- **PUB JUKEBOX** — samostatný gastro modul pro hosty, QR, frontu, TV a AutoDJ.

## PUB CORE

PUB CORE je neveřejná technická vrstva. Sdílí identitu organizace/provozovny, oprávnění, katalog, receptury a skladová data mezi gastro aplikacemi.

Zásadní pravidlo: sklad není společný mezi zákazníky ani provozovnami. Každá provozovna má svůj vlastní sklad. POS, INVOICES a INVENTORY jedné provozovny pouze pracují nad stejnými skladovými daty této provozovny.

Veškerá provozní data musí být tenant-scoped minimálně přes `organization_id` a `venue_id`. Přístup mezi organizacemi nesmí být možný.

## PUB MUSIC

PUB MUSIC není součástí gastro platformy. Je to samostatný hudební produkt s vlastním backendem, úložištěm, uživateli a monetizací. Sdílet může pouze vizuální DNA značky PUB.

## Kompatibilita

Historické adresáře `pub_bizz_pos` a `pub_guru` se zatím nepřejmenovávají, aby se nerozbily existující URL, PWA instalace, cache ani nasazení. V uživatelském rozhraní používáme pouze názvy PUB POS a PUB INVOICES. Přesun technických cest se provede až s řízenou migrací a redirecty.
