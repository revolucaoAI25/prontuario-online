import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitHistory, parseLegacyDate } from '../../scripts/lib/fastclinic-history.mjs';

const TODAY = new Date('2026-10-27T12:00:00Z');

test('splits dated lines into entries and keeps continuation lines', () => {
  const text = [
    '07.07.98 - Peeling Ata face total',
    '17.07.98 - 7 + bloq',
    '=======',
    '24.09.98 - Botox 4p orbic  + 4p corrug ',
    'continua: retorno em 15 dias',
    '',
    '28.05.15 - Botox 5c + 6f + 6o',
  ].join('\r\n');
  assert.deepEqual(splitHistory(text, TODAY), [
    { date: '1998-07-07', content: 'Peeling Ata face total' },
    { date: '1998-07-17', content: '7 + bloq' },
    { date: '1998-09-24', content: 'Botox 4p orbic  + 4p corrug\ncontinua: retorno em 15 dias' },
    { date: '2015-05-28', content: 'Botox 5c + 6f + 6o' },
  ]);
});

test('text before the first date is kept undated', () => {
  assert.deepEqual(splitHistory('Alérgica a dipirona\n01.12.11 - L + Cristal', TODAY), [
    { date: null, content: 'Alérgica a dipirona' },
    { date: '2011-12-01', content: 'L + Cristal' },
  ]);
});

test('invalid or implausible dates are treated as text of the previous entry', () => {
  assert.deepEqual(splitHistory('01.08.14 - Cristal\n31.02.15 - erro de digitação\n12.12.62 - antigo', TODAY), [
    { date: '2014-08-01', content: 'Cristal\n31.02.15 - erro de digitação\n12.12.62 - antigo' },
  ]);
});

test('two- and four-digit years, slashes and missing dash', () => {
  assert.equal(parseLegacyDate('20', '7', '26', TODAY), '2026-07-20');
  assert.equal(parseLegacyDate('20', '7', '27', TODAY), null, 'future');
  assert.equal(parseLegacyDate('3', '4', '2019', TODAY), '2019-04-03');
  assert.deepEqual(splitHistory('3/4/2019 Limpeza', TODAY), [{ date: '2019-04-03', content: 'Limpeza' }]);
});

test('an empty or blank history yields no entries', () => {
  assert.deepEqual(splitHistory(null, TODAY), []);
  assert.deepEqual(splitHistory('\r\n  \r\n=====', TODAY), []);
});
