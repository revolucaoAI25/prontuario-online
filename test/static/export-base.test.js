import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from '../../src/lib/xlsx.js';
import { firstName, firstTwoNames, properName, whatsappDigits } from '../../src/lib/names.js';

test('names for the exported base: proper case, first name, first and second names', () => {
  assert.equal(properName('MARIA DE LOURDES SILVA'), 'Maria de Lourdes Silva');
  assert.equal(firstName('ana paula costa'), 'Ana');
  assert.equal(firstTwoNames('ana paula costa'), 'Ana Paula');
  assert.equal(firstTwoNames('Maria de Lourdes Silva'), 'Maria de Lourdes', 'a "de" in between comes along');
  assert.equal(firstTwoNames('Beatriz Pessoa e do Val'), 'Beatriz Pessoa');
  assert.equal(firstTwoNames('José'), 'José');
});

test('phones as WhatsApp wants them: 55 + DDD + number, digits only', () => {
  assert.equal(whatsappDigits('(31) 99999-0000'), '5531999990000');
  assert.equal(whatsappDigits('+55 (31) 99999-0000'), '5531999990000');
  assert.equal(whatsappDigits('031 99999-0000'), '5531999990000');
  assert.equal(whatsappDigits('31 3333-4444'), '553133334444');
  assert.equal(whatsappDigits('(55) 99999-0000'), '5555999990000', 'DDD 55 (RS)');
  assert.equal(whatsappDigits('99999-0000'), null, 'no DDD');
  assert.equal(whatsappDigits(''), null);
});

test('the .xlsx is a zip with the sheet, text kept as text and dates as dates', () => {
  const bytes = buildXlsx({ columns: [{ header: 'Nome' }, { header: 'Telefone' }, { header: 'Data' }], rows: [['Ana & Bia', '5531999990000', { date: '2026-05-03' }]] });
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'zip header');
  const text = new TextDecoder().decode(bytes);
  assert.match(text, /xl\/worksheets\/sheet1\.xml/);
  assert.match(text, /<t xml:space="preserve">5531999990000<\/t>/, 'the phone is text, every digit kept');
  assert.match(text, /<c r="C2" s="2"><v>46145<\/v><\/c>/, '03/05/2026 as an Excel date');
  assert.match(text, /Ana &amp; Bia/);
  assert.match(text, /formatCode="dd\/mm\/yyyy"/);
});
