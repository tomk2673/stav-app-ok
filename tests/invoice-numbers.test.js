'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseMoney,parseQuantity}=require('../pub_guru/invoice-numbers.js');

test('Czech whole-crown amounts group thousands without reinterpreting supplier quantities',()=>{
  for(const [value,expected] of [['5.812,-',5812],['5 812,00',5812],['5\u00a0812,00 Kč',5812],
    ['1.000,-',1000],['1.234.567,-',1234567],['-1.000,-',-1000],['−5.812,- CZK',-5812],['1000,-',1000],['0,-',0]]){
    assert.equal(parseMoney(value),expected,value);
  }
  for(const [value,expected] of [['1,000',1],['1.000',1],['1,5',1.5],['-1,000',-1],['0.125',0.125],['1 234,000',1234]]){
    assert.equal(parseQuantity(value),expected,value);
  }
  assert.ok(Number.isNaN(parseQuantity('1.000,-')),'currency notation is not a quantity');
});

test('decimal unit prices retain precision, mixed grouping supports OCR output and numeric zero is real',()=>{
  for(const [value,expected] of [[0,0],[5.812,5.812],['5,812',5.812],['5.812',5.812],['1.234,56',1234.56],
    ['1,234.56',1234.56],['1.234.567',1234567],['0,1234',0.1234],['-0,01',-0.01]]){
    assert.equal(parseMoney(value),expected,String(value));
  }
});

test('missing, malformed and ambiguous numeric input never silently becomes zero or another value',()=>{
  for(const value of [null,undefined,'',' ','--100','100-','1.23.456,-','1,00,00','1.23,45','1e3','NaN','100 Kč text',Infinity]){
    assert.ok(Number.isNaN(parseMoney(value)),String(value));
  }
});
