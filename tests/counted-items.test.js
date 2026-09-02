'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectCountedItemKey,
  bestProductMatch,
  extractInvoiceQuantity,
  signedInvoiceQuantity,
  boundCountedQuantity,
  capCountedMovement,
  ensureCountedCatalog
} = require('../stav_app/app.js');

test('rozpozná všechny tři skupiny vratných obalů', () => {
  assert.equal(detectCountedItemKey('Vratný obal – přepravka'), 'packaging_crate');
  assert.equal(detectCountedItemKey('ZÁLOHA SKLO'), 'packaging_bottle');
  assert.equal(detectCountedItemKey('SUD KEG'), 'packaging_keg');
});

test('nepovažuje plný pivní KEG automaticky za prázdný obal', () => {
  assert.equal(detectCountedItemKey('Radegast Rázná 10 KEG 50 l'), null);
});

test('rozpozná spotřební materiál', () => {
  assert.equal(detectCountedItemKey('LDPE pytle na odpad 120 l'), 'consumable_waste_bags');
  assert.equal(detectCountedItemKey('Pytle 120 l'), 'consumable_waste_bags');
  assert.equal(detectCountedItemKey('Odmašťovač na úklid'), 'consumable_cleaning');
  assert.equal(detectCountedItemKey('Čistič skla'), 'consumable_cleaning');
  assert.equal(detectCountedItemKey('Sanitační chemie na pivní vedení'), 'consumable_sanitation');
});

test('párování vrátí správný typ katalogové položky', () => {
  const crate = bestProductMatch('vratná přepravka');
  const sanitation = bestProductMatch('dezinfekce na sanitaci');
  assert.equal(crate.product.itemSubtype, 'crate');
  assert.equal(crate.product.itemKind, 'packaging');
  assert.equal(sanitation.product.itemSubtype, 'sanitation');
  assert.equal(sanitation.product.itemKind, 'consumable');
});

test('načte záporné množství i množství za názvem přepravky', () => {
  assert.equal(extractInvoiceQuantity('Vratné sklo -12 ks -36,00', 'packaging_bottle'), -12);
  assert.equal(extractInvoiceQuantity('Přepravka 4 400,00', 'packaging_crate'), 4);
  assert.equal(extractInvoiceQuantity('Sklo 80 -240,00', 'packaging_bottle'), 80);
  assert.equal(extractInvoiceQuantity('Sud 50 l 1 ks 1000,00', 'packaging_keg'), 1);
  assert.equal(extractInvoiceQuantity('Sud 50 l 1000,00', 'packaging_keg'), 1);
  assert.equal(signedInvoiceQuantity(12, -3), -12);
  assert.equal(signedInvoiceQuantity(-12, 3), -12);
});

test('kusový pohyb se při chybějícím počátečním stavu nedostane pod nulu', () => {
  const product = ensureCountedCatalog([]).find(item => item.itemSubtype === 'crate');
  const movement = capCountedMovement(product.id, -5);
  assert.equal(Object.is(movement.applied, -0), true);
  assert.equal(movement.untracked, 5);
  assert.deepEqual(boundCountedQuantity(4, -10), { applied: -4, untracked: 6 });
  assert.deepEqual(boundCountedQuantity(10, -4), { applied: -4, untracked: 0 });
});
